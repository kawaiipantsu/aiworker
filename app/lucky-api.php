<?php
declare(strict_types=1);
require_once __DIR__ . "/secrets.php";
function handle_lucky_action(string $action, string $method, array $u): void
{
    if ($action === "openai_status") {
        admin($u);
        $login = q(
            "SELECT id,status,verification_url,user_code,error,created_at,expires_at FROM openai_logins ORDER BY created_at DESC LIMIT 1",
        )->fetch();
        output([
            "connection" => connection_metadata(),
            "login" => $login ?: null,
            "service" => (bool) redis()->get("ideas:heartbeat"),
        ]);
    }
    if ($action === "openai_save" && $method === "POST") {
        admin($u);
        $key = bounded("api_key", 512);
        if (!preg_match('/^sk-[A-Za-z0-9_-]{16,500}$/D', $key)) {
            fail("Enter a valid OpenAI API key beginning with sk-.");
        }
        $secret = seal_secret(
            json_encode(["api_key" => $key], JSON_THROW_ON_ERROR),
        );
        db()->beginTransaction();
        q("SELECT id FROM openai_connection WHERE id=1 FOR UPDATE");
        q(
            "UPDATE openai_connection SET mode='api_key',credential=?,label=?,revision=revision+1,verified_at=NULL,last_error=NULL,updated_by=? WHERE id=1",
            [$secret, "API key · …" . substr($key, -4), $u["id"]],
        );
        q(
            "UPDATE openai_logins SET status='cancelled',user_code=NULL WHERE status IN ('queued','starting','waiting')",
        );
        audit("openai.key_saved", "idea-generator");
        db()->commit();
        output(["ok" => true, "connection" => connection_metadata()]);
    }
    if ($action === "openai_reset" && $method === "POST") {
        admin($u);
        db()->beginTransaction();
        q("SELECT id FROM openai_connection WHERE id=1 FOR UPDATE");
        q(
            "UPDATE openai_connection SET mode='none',credential=NULL,label=NULL,revision=revision+1,verified_at=NULL,last_error=NULL,updated_by=? WHERE id=1",
            [$u["id"]],
        );
        q(
            "UPDATE openai_logins SET status='cancelled',user_code=NULL WHERE status IN ('queued','starting','waiting')",
        );
        q(
            "UPDATE lucky_drafts SET status='cancelled',error='OpenAI connection was reset.',finished_at=NOW(3) WHERE status IN ('queued','running')",
        );
        audit("openai.reset", "idea-generator");
        db()->commit();
        output(["ok" => true]);
    }
    if ($action === "openai_login" && $method === "POST") {
        admin($u);
        if (!redis()->get("ideas:heartbeat")) {
            fail("The idea service is offline. Try again shortly.", 503);
        }
        db()->beginTransaction();
        $revision = q(
            "SELECT revision FROM openai_connection WHERE id=1 FOR UPDATE",
        )->fetchColumn();
        q(
            "UPDATE openai_logins SET status='cancelled',user_code=NULL WHERE status IN ('queued','starting','waiting')",
        );
        $id = uuid();
        q(
            "INSERT INTO openai_logins(id,user_id,revision,expires_at) VALUES(?,?,?,DATE_ADD(NOW(3),INTERVAL 15 MINUTE))",
            [$id, $u["id"], $revision],
        );
        audit("openai.login_started", "idea-generator");
        db()->commit();
        output(["id" => $id], 202);
    }
    if ($action === "openai_login_cancel" && $method === "POST") {
        admin($u);
        $id = bounded("id", 36);
        q(
            "UPDATE openai_logins SET status='cancelled',user_code=NULL WHERE id=? AND status IN ('queued','starting','waiting')",
            [$id],
        );
        audit("openai.login_cancelled", "idea-generator");
        output(["ok" => true]);
    }
    if (
        in_array($action, ["lucky_generate", "openai_test"], true) &&
        $method === "POST"
    ) {
        if ($action === "openai_test") {
            admin($u);
        }
        if (!redis()->get("ideas:heartbeat")) {
            fail("The idea service is offline. Try again shortly.", 503);
        }
        db()->beginTransaction();
        $connection = q(
            "SELECT revision,mode FROM openai_connection WHERE id=1 FOR UPDATE",
        )->fetch();
        if ($connection["mode"] === "none") {
            fail(
                "Connect OpenAI in Administration before using I feel lucky.",
                409,
            );
        }
        $pending = q(
            "SELECT id,status,kind FROM lucky_drafts WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM suggestions WHERE draft_id=lucky_drafts.id) AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
            [$u["id"]],
        )->fetch();
        if ($pending) {
            if (
                $pending["kind"] !==
                ($action === "openai_test" ? "test" : "idea")
            ) {
                fail("Your previous OpenAI request is still running.", 409);
            }
            db()->commit();
            output(
                [
                    "id" => $pending["id"],
                    "status" => $pending["status"],
                    "model" => "gpt-5.6-terra",
                ],
                202,
            );
        }
        if (
            q(
                "SELECT COUNT(*) FROM lucky_drafts WHERE user_id=? AND created_at>DATE_SUB(NOW(3),INTERVAL 1 HOUR)",
                [$u["id"]],
            )->fetchColumn() >= 20
        ) {
            fail(
                "Idea generation is limited to 20 requests per hour per user.",
                429,
            );
        }
        if (
            q(
                "SELECT COUNT(*) FROM lucky_drafts WHERE status IN ('queued','running')",
            )->fetchColumn() >= 8
        ) {
            fail("The idea queue is busy. Try again shortly.", 429);
        }
        $id = uuid();
        q(
            "INSERT INTO lucky_drafts(id,user_id,revision,kind,with_scaffold) VALUES(?,?,?,?,?)",
            [
                $id,
                $u["id"],
                $connection["revision"],
                $action === "openai_test" ? "test" : "idea",
                !empty($_POST["with_scaffold"]) ? 1 : 0,
            ],
        );
        audit(
            $action === "openai_test" ? "openai.test" : "lucky.generate",
            $id,
        );
        db()->commit();
        output(
            ["id" => $id, "status" => "queued", "model" => "gpt-5.6-terra"],
            202,
        );
    }
    if (
        in_array(
            $action,
            ["lucky_status", "lucky_scaffold", "lucky_discard"],
            true,
        )
    ) {
        $id = (string) ($_GET["draft"] ?? "");
        $draft = q("SELECT *,EXISTS(SELECT 1 FROM suggestions WHERE draft_id=lucky_drafts.id) AS suggestion FROM lucky_drafts WHERE id=? AND (user_id=? OR EXISTS(SELECT 1 FROM suggestions WHERE draft_id=lucky_drafts.id))", [
            $id,
            $u["id"],
        ])->fetch();
        if (!$draft) {
            fail("Draft not found.", 404);
        }
        if ($action === "lucky_discard" && $method === "POST") {
            if ($draft["suggestion"]) { output(["ok" => true]); }
            q(
                "UPDATE lucky_drafts SET status='cancelled',scaffold=NULL,finished_at=NOW(3) WHERE id=? AND status IN ('queued','running','ready')",
                [$id],
            );
            audit("lucky.abort", $id);
            output(["ok" => true]);
        }
        if ($action === "lucky_scaffold") {
            if (
                !in_array($draft["status"], ["ready", "used"], true) ||
                $draft["scaffold"] === null
            ) {
                fail("No generated scaffolding is available.", 404);
            }
            session_write_close();
            header("Content-Type: application/zip");
            header(
                'Content-Disposition: attachment; filename="aiworker-scaffold.zip"',
            );
            header("Content-Length: " . strlen($draft["scaffold"]));
            echo $draft["scaffold"];
            exit();
        }
        if ($action === "lucky_status") {
            output([
                "id" => $id,
                "status" => $draft["status"],
                "model" => "gpt-5.6-terra",
                "result" => $draft["result"]
                    ? json_decode($draft["result"], true)
                    : null,
                "has_scaffold" => $draft["scaffold"] !== null,
                "suggestion" => (bool) $draft["suggestion"],
                "error" => $draft["error"],
            ]);
        }
    }
}

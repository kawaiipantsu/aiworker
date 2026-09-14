#!/usr/bin/php
<?php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit(1); }
require __DIR__ . '/../app/bootstrap.php';
require __DIR__ . '/../app/secrets.php';
if (!q("SELECT GET_LOCK('aiworker_suggestions',0)")->fetchColumn()) { exit(0); }
try {
    db()->beginTransaction();
    $count = max(0, min(20, (int) setting('suggestions_daily_count', 2)));
    $connection = q('SELECT revision,mode FROM openai_connection WHERE id=1 FOR UPDATE')->fetch();
    $owner = q("SELECT id FROM users WHERE active=1 AND role='admin' ORDER BY id LIMIT 1")->fetchColumn();
    if (!$count || !$owner || !$connection || $connection['mode'] === 'none') {
        db()->rollBack();
        echo "Suggestions skipped: disabled, no administrator, or OpenAI disconnected.\n";
        exit(0);
    }
    $day = (new DateTimeImmutable('now', new DateTimeZone('Europe/Copenhagen')))->format('Y-m-d');
    $created = 0;
    for ($slot = 1; $slot <= $count; $slot++) {
        if (q('SELECT draft_id FROM suggestions WHERE batch_date=? AND slot=?', [$day, $slot])->fetchColumn()) { continue; }
        $id = uuid();
        q('INSERT INTO lucky_drafts(id,user_id,revision,with_scaffold) VALUES(?,?,?,0)', [$id, $owner, $connection['revision']]);
        q('INSERT INTO suggestions(draft_id,batch_date,slot) VALUES(?,?,?)', [$id, $day, $slot]);
        $created++;
    }
    audit('suggestions.generate', $day, "Queued $created suggestion(s)");
    db()->commit();
    echo "Queued $created suggestion(s) for $day.\n";
} finally {
    if (db()->inTransaction()) { db()->rollBack(); }
    q("SELECT RELEASE_LOCK('aiworker_suggestions')");
}

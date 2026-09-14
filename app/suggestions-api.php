<?php
declare(strict_types=1);
function suggestions_api(string $action, string $method, array $u): void
{
    if ($action === 'lucky_categories') {
        admin($u);
        if ($method === 'POST') {
            if (!empty($_POST['reset'])) {
                q("DELETE FROM settings WHERE `key`='lucky_categories'");
            } else {
                $text = bounded('categories', 12000);
                $categories = array_values(array_unique(array_filter(array_map('trim', preg_split('/\R/u', $text)), static fn($v) => $v !== '')));
                if (count($categories) < 1 || count($categories) > 100) { fail('Enter 1–100 categories, one per line.'); }
                foreach ($categories as $category) {
                    if (mb_strlen($category) > 100 || preg_match('/[\x00-\x1f\x7f]/u', $category)) { fail('Each category must contain 1–100 characters without control characters.'); }
                }
                q("INSERT INTO settings(`key`,value) VALUES('lucky_categories',?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [json_encode($categories)]);
            }
            audit('lucky.categories_updated', 'idea-generator');
        }
        output(['categories' => setting('lucky_categories', json_decode(file_get_contents(__DIR__ . '/lucky-categories.json'), true))]);
    }
    if ($action === 'lucky_prompt') {
        admin($u);
        if ($method === 'POST') {
            if (!empty($_POST['reset'])) {
                q("DELETE FROM settings WHERE `key`='lucky_prompt'");
            } else {
                $prompt = bounded('prompt', 20000);
                q("INSERT INTO settings(`key`,value) VALUES('lucky_prompt',?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [json_encode($prompt)]);
            }
            audit('lucky.prompt_updated', 'idea-generator');
        }
        output(['prompt' => setting('lucky_prompt', file_get_contents(__DIR__ . '/lucky-prompt.txt'))]);
    }
    if ($action === 'suggestions_settings'  && $method === 'POST') {
        admin($u);
        $count = filter_var($_POST['count'] ?? null, FILTER_VALIDATE_INT);
        if ($count === false || $count < 0 || $count > 20) { fail('Choose between 0 and 20 suggestions per day.'); }
        q("INSERT INTO settings(`key`,value) VALUES('suggestions_daily_count',?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [json_encode($count)]);
        audit('suggestions.settings', (string) $count);
        output(['ok' => true]);
    }
    if ($action === 'suggestions') {
        $page = max(1, (int) ($_GET['page'] ?? 1));
        $search = '%' . mb_substr((string) ($_GET['search'] ?? ''), 0, 160) . '%';
        $where = "FROM suggestions s JOIN lucky_drafts d ON d.id=s.draft_id WHERE d.status NOT IN ('used','cancelled') AND (d.result LIKE ? OR d.result IS NULL)";
        $total = (int) q("SELECT COUNT(*) $where", [$search])->fetchColumn();
        $offset = ($page - 1) * 50;
        $rows = q("SELECT d.id,d.status,d.result,d.error,d.created_at $where ORDER BY d.created_at DESC,d.id LIMIT 50 OFFSET $offset", [$search])->fetchAll();
        foreach ($rows as &$row) { $row['result'] = $row['result'] ? json_decode($row['result'], true) : null; }
        output(['suggestions' => $rows, 'total' => $total]);
    }
    if ($action === 'suggestion_drop' && $method === 'POST') {
        $id = bounded('id', 36);
        $changed = q("UPDATE lucky_drafts d JOIN suggestions s ON s.draft_id=d.id SET d.status='cancelled',d.scaffold=NULL,d.finished_at=NOW(3) WHERE d.id=? AND d.status IN ('queued','running','ready','failed')", [$id]);
        if (!$changed->rowCount()) { fail('Suggestion is no longer available.', 409); }
        audit('suggestions.drop', $id);
        output(['ok' => true]);
    }
}

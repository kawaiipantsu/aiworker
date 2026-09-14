<?php
if (PHP_SAPI !== 'cli') { http_response_code(404); exit(1); }
require_once __DIR__ . '/../app/bootstrap.php';
if (!q("SHOW COLUMNS FROM jobs LIKE 'workspace'")->fetch()) {
    db()->exec('ALTER TABLE jobs ADD COLUMN workspace VARCHAR(700) COLLATE utf8mb4_bin NULL, ADD COLUMN workspace_ready BOOLEAN NOT NULL DEFAULT 0');
}
q('UPDATE jobs SET workspace=CONCAT(?, "/", slug), workspace_ready=1 WHERE workspace IS NULL', [rtrim($config['projects'], '/')]);
if (!q("SHOW INDEX FROM jobs WHERE Key_name='workspace'")->fetch()) {
    db()->exec('ALTER TABLE jobs MODIFY workspace VARCHAR(700) COLLATE utf8mb4_bin NOT NULL, ADD UNIQUE KEY workspace (workspace)');
}
if (q("SHOW INDEX FROM jobs WHERE Key_name='slug' AND Non_unique=0")->fetch()) {
    db()->exec('ALTER TABLE jobs DROP INDEX slug, ADD INDEX slug (slug)');
}

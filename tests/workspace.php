<?php
require __DIR__ . '/../app/workspace.php';
foreach ([
    'app.example.com' => 'app.example.com',
    'EXAMPLE.COM.' => 'example.com',
    'my great project' => 'my-great-project',
    '../example.com' => 'example-com',
    'https://example.com' => 'https-example-com',
    'bad_label.example.com' => 'bad-label-example-com',
    'a..example.com' => 'a-example-com',
    '' => 'project',
] as $input => $expected) {
    if (project_folder($input, false) !== $expected) throw new RuntimeException($input);
    if (!preg_match('/^' . preg_quote($expected, '/') . '-[a-f0-9]{8}$/D', project_folder($input))) throw new RuntimeException('Unique ID missing');
}
if (project_base('/tmp/') !== '/tmp') throw new RuntimeException('Trailing slash');
foreach (['/', '../tmp', '/tmp/../tmp', '/tmp//child'] as $base) {
    try { project_base($base); throw new RuntimeException('Unsafe base accepted: ' . $base); }
    catch (InvalidArgumentException) {}
}
echo "FQDN names, slug fallback, unique IDs and base path validation passed.\n";

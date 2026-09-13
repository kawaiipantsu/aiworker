<?php
// Worker-side extraction repeats validation; archives never enter the web root.
require __DIR__ . "/../app/bootstrap.php";
if (PHP_SAPI !== "cli") {
    exit(1);
}
$id = (int) ($argv[1] ?? 0);
$job = q("SELECT slug FROM jobs WHERE id=?", [$id])->fetch();
if (!$job) {
    throw new RuntimeException("Job missing");
}
$root = $argv[2] ?? $config["projects"] . "/" . $job["slug"];
if (
    isset($argv[2]) &&
    $root !== $config["projects"] . "/.aiworker-stage-" . $id
) {
    throw new RuntimeException("Invalid staging path");
}
if (
    !preg_match('/^[a-z0-9-]+$/D', $job["slug"]) ||
    is_link($root) ||
    !is_dir($root)
) {
    throw new RuntimeException("Unsafe workspace");
}
$upload = q("SELECT data FROM uploads WHERE job_id=?", [$id])->fetchColumn();
if ($upload === false) {
    exit();
}
$tmp = tempnam(ROOT . "/var/uploads", "zip-");
try {
    file_put_contents($tmp, $upload);
    validate_zip($tmp);
    $z = new ZipArchive();
    $z->open($tmp);
    for ($i = 0; $i < $z->numFiles; $i++) {
        $n = $z->getNameIndex($i);
        if ($n === "" || $n === "./") {
            continue;
        }
        $parts = explode("/", trim($n, "/"));
        $path = $root;
        foreach ($parts as $index => $part) {
            if ($part === "." || $part === "") {
                continue;
            }
            $path .= "/" . $part;
            if (is_link($path)) {
                throw new RuntimeException("Symlink in extraction path");
            }
            if ($index < count($parts) - 1 || str_ends_with($n, "/")) {
                if (!is_dir($path) && !mkdir($path, 0770)) {
                    throw new RuntimeException("Cannot create directory");
                }
            }
        }
        if (!str_ends_with($n, "/")) {
            $in = $z->getStream($n);
            $out = fopen($path, "xb");
            if (!$in || !$out) {
                throw new RuntimeException("Archive collision");
            }
            $copied = stream_copy_to_stream($in, $out, 268435457);
            fclose($in);
            fclose($out);
            if ($copied > 268435456) {
                throw new RuntimeException("Expansion limit");
            }
            chmod($path, 0660);
        }
    }
    $z->close();
} finally {
    unlink($tmp);
}

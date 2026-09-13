<?php
require __DIR__ . "/../app/bootstrap.php";
$path = $argv[1] ?? "/var/lib/aiworker/.codex/models_cache.json";
$data = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
$models = [];
$efforts = [];
foreach ($data["models"] ?? [] as $m) {
    if (
        str_starts_with($m["slug"] ?? "", "gpt-") &&
        ($m["visibility"] ?? "list") !== "hide"
    ) {
        $models[] = $m["slug"];
        $efforts[$m["slug"]] = array_column(
            $m["supported_reasoning_levels"] ?? [],
            "effort",
        );
    }
}
if (!$models) {
    throw new RuntimeException("No models found in CLI cache");
}
q("UPDATE settings SET value=? WHERE `key`=?", [
    json_encode($models),
    "models_codex",
]);
q(
    "INSERT INTO settings(`key`,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    ["efforts_codex", json_encode($efforts)],
);
echo "Codex model catalog synchronized.\n";

<?php
declare(strict_types=1);
require_once "/usr/share/php/tcpdf/tcpdf.php";
class CompletedReport extends TCPDF
{
    public function Footer()
    {
        $this->SetY(-15);
        $this->SetFont("dejavusans", "", 8);
        $this->SetTextColor(100, 116, 139);
        $this->Cell(0, 6, "AI WORKER · Kawaiipantsu · thugs.red", 0, 0);
        $this->Cell(
            0,
            6,
            $this->getAliasNumPage() . " / " . $this->getAliasNbPages(),
            0,
            0,
            "R",
        );
    }
}
function completed_pdf(
    array $rows,
    string $search,
    string $provider,
    string $filename,
): never {
    $pdf = new CompletedReport("P", "mm", "A4", true, "UTF-8", false);
    $pdf->SetCreator("AI Worker");
    $pdf->SetAuthor("Kawaiipantsu");
    $pdf->SetTitle("Completed projects · AI Worker");
    $pdf->setPrintHeader(false);
    $pdf->SetMargins(18, 18, 18);
    $pdf->SetAutoPageBreak(true, 23);
    $pdf->AddPage();
    $pdf->SetTextColor(23, 37, 54);
    $pdf->SetFont("dejavusans", "B", 11);
    $pdf->Cell(0, 8, "AI WORKER / THE AUTONOMOUS WORKSHOP", 0, 1);
    $pdf->SetFont("dejavusans", "B", 27);
    $pdf->Cell(0, 15, "Completed projects", 0, 1);
    $pdf->SetFont("dejavusans", "", 10);
    $pdf->SetTextColor(80, 96, 115);
    $pdf->MultiCell(
        0,
        6,
        "Generated " .
            gmdate("d M Y, H:i") .
            " UTC · " .
            count($rows) .
            " completed projects" .
            "\n" .
            "Provider: " .
            ($provider ?: "All") .
            " · Search: " .
            ($search ?: "All projects"),
        0,
        "L",
    );
    $pdf->Ln(8);
    $e = static fn($s) => htmlspecialchars(
        (string) ($s ?? ""),
        ENT_QUOTES | ENT_SUBSTITUTE,
        "UTF-8",
    );
    if (!$rows) {
        $pdf->MultiCell(0, 8, "No completed projects match these filters.");
    }
    foreach ($rows as $r) {
        if ($pdf->GetY() > 230) {
            $pdf->AddPage();
        }
        $pdf->SetFillColor(235, 242, 249);
        $pdf->SetTextColor(23, 37, 54);
        $pdf->SetFont("dejavusans", "B", 13);
        $pdf->MultiCell(
            0,
            10,
            "#" . $r["id"] . "  " . $r["name"],
            0,
            "L",
            true,
        );
        $pdf->SetFont("dejavusans", "", 9);
        $pdf->Ln(3);
        $html =
            "<b>" .
            $e(ucfirst($r["provider"])) .
            "</b> · " .
            $e($r["model"]) .
            "<br>Completed: " .
            $e($r["finished_at"] ?: "Not recorded") .
            " UTC<br>Created: " .
            $e($r["created_at"]) .
            " UTC<br>Workspace: /srv/projects/" .
            $e($r["slug"]);
        $pdf->writeHTML($html, true, false, true, false, "");
        $pdf->Ln(2);
        $pdf->SetFont("dejavusans", "", 10);
        $pdf->MultiCell(
            0,
            6,
            $r["summary"] ?: "No completion summary recorded.",
            0,
            "L",
        );
        $pdf->Ln(9);
    }
    $pdf->Output($filename, "D");
    exit();
}

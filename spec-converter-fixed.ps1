# Spec Converter - Fixed for Unicode/Cyrillic support
# Usage: .\spec-converter-fixed.ps1 [ProjectDir]

param(
    [string]$ProjectDir = $(Get-Location)
)

$TasksFile = Join-Path $ProjectDir "tasks.md"
$SpecsDir = Join-Path $ProjectDir "specs"
$PlanningFile = Join-Path $ProjectDir "planning.md"
$ClaudeFile = Join-Path $ProjectDir "CLAUDE.md"
$PrdFile = Join-Path $ProjectDir "PRD.md"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "   Spec Converter (Unicode-safe)" -ForegroundColor Cyan
Write-Host "============================================"
Write-Host ""
Write-Host "Project: $ProjectDir" -ForegroundColor Blue

if (!(Test-Path $TasksFile)) {
    Write-Host "ERROR: tasks.md not found" -ForegroundColor Red
    exit 1
}

if (!(Test-Path $SpecsDir)) {
    New-Item -ItemType Directory -Path $SpecsDir | Out-Null
}

Write-Host "Output: $SpecsDir" -ForegroundColor Blue
Write-Host ""

# Read with UTF-8 encoding that preserves Cyrillic
$lines = [System.IO.File]::ReadAllLines($TasksFile, [System.Text.UTF8Encoding]::new($false))
$currentSprint = ""
$sprintNum = 0
$sprintTasks = @()
$sprintCompleted = @()
$specsCreated = 0
$allLines = $lines
$i = 0

function Create-Spec {
    param(
        [int]$SprintNum,
        [string]$SprintName,
        [string[]]$Tasks,
        [string[]]$CompletedTasks
    )
    # ... (function body remains the same but use $Tasks and $CompletedTasks)
    $safeName = $SprintName -replace '[<>:"/\\|?*]', ''
    $safeName = $safeName.Substring(0, [Math]::Min(50, $safeName.Length)).Trim()

    # Проверяем дубликаты по НОМЕРУ спринта (не по полному имени)
    # Это предотвращает создание второй папки при переименовании спринта
    $prefix = "{0:D3}-" -f $SprintNum
    $existingDirs = Get-ChildItem -Path $SpecsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($prefix) }
    if ($existingDirs) {
        $existingDir = $existingDirs[0].FullName
        $existingSpec = Join-Path $existingDir "spec.md"
        if (Test-Path $existingSpec) {
            Write-Host "  Skip: $($existingDirs[0].Name) (exists for sprint $SprintNum)" -ForegroundColor Yellow
            return 0
        }
    }

    $specDir = Join-Path $SpecsDir ("{0:D3}-{1}" -f $SprintNum, $safeName)
    $specFile = Join-Path $specDir "spec.md"

    if (!(Test-Path $specDir)) {
        New-Item -ItemType Directory -Path $specDir | Out-Null
    }

    $tasksText = ($CompletedTasks + $Tasks) -join "`n"

    $contextLinks = ""
    if (Test-Path $PlanningFile) { $contextLinks += "- [Planning](../planning.md)`n" }
    if (Test-Path $ClaudeFile) { $contextLinks += "- [Guidelines](../CLAUDE.md)`n" }
    if (Test-Path $PrdFile) { $contextLinks += "- [PRD](../PRD.md)`n" }

    $incompleteCount = $Tasks.Count

    # Формируем путь для команды запуска
    $specDirName = "{0:D3}-{1}" -f $SprintNum, $safeName
    $specPath = "specs/$specDirName/spec.md"

    # Извлечение референсов из задач спринта
    $refsSection = ""
    $refsDir = Join-Path $ProjectDir "refs"
    $specRefsDir = Join-Path $specDir "refs"
    $allTasksText = ($CompletedTasks + $Tasks) -join "`n"
    $refLines = [regex]::Matches($allTasksText, '-\s*ref:\s*(\S+)\s*-\s*(.+)')
    if ($refLines.Count -gt 0) {
        $refsSection = "`n## Референсы`n"
        if (!(Test-Path $specRefsDir)) {
            New-Item -ItemType Directory -Path $specRefsDir | Out-Null
        }
        foreach ($ref in $refLines) {
            $refFile = $ref.Groups[1].Value
            $refDesc = $ref.Groups[2].Value.Trim()
            $srcPath = Join-Path $refsDir $refFile
            if (Test-Path $srcPath) {
                Copy-Item $srcPath (Join-Path $specRefsDir $refFile) -Force
                $refsSection += "- ![$refDesc](refs/$refFile)`n"
                Write-Host "    Ref copied: $refFile" -ForegroundColor Magenta
            } else {
                $refsSection += "- $refFile - $refDesc (файл не найден)`n"
                Write-Host "    Ref NOT FOUND: $refFile" -ForegroundColor Yellow
            }
        }
    }

    $content = "# Спринт ${SprintNum}: $SprintName`n`n" +
               "## Команда запуска для Ralph Runner`n" +
               "``claude -p `"Прочитай этот файл ($specPath). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам из claude.md и применяй глобальные навыки (TDD, Debugging). ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md и корневой tasks.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>, а затем напиши блок <report>...</report>, внутри которого должен быть только строгий JSON с ключами: 'exact_task_name' (в точности скопируй строку задачи из файла), 'summary' (подробное описание того, что сделано), 'skills_used' (массив названий навыков, которые ты применил).`"``" +
               "`n`n## Ссылки на контекст`n" +
               "- [Планирование](../../planning.md)`n" +
               "- [Правила](../../CLAUDE.md)`n" +
               "- [PRD](../../PRD.md)`n`n" +
               "## Tasks`n`n" +
               "$tasksText`n`n" +
               "$refsSection" +
               "## Критерии завершения`n" +
               "- [ ] Все $incompleteCount невыполненных задач реализованы и протестированы.`n" +
               "- [ ] Файл ``tasks.md`` обновлен (поставлены [x] для завершенных пунктов).`n"

    [System.IO.File]::WriteAllText($specFile, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  Created: $specDir" -ForegroundColor Green
    return 1
}

while ($i -lt $allLines.Count) {
    $line = $allLines[$i]

    if ($line -match '^##\s+(?:Спринт|Sprint)?\s*(\d+(?:\s*[-–]\s*\d+)?)\s*:\s*(.+)') {
        if ($currentSprint -ne "" -and ($sprintTasks.Count -gt 0 -or $sprintCompleted.Count -gt 0)) {
            $specsCreated += Create-Spec -SprintNum $sprintNum -SprintName $currentSprint -Tasks $sprintTasks -CompletedTasks $sprintCompleted
        }
        $sprintNumRaw = $matches[1]
        $sprintNameRaw = $matches[2]
        if ($sprintNumRaw -match '^(\d+)') {
            $sprintNum = [int]$Matches[1]
        } else {
            $sprintNum = [int]$sprintNumRaw
        }
        $currentSprint = $sprintNameRaw.Trim()
        $sprintTasks = @()
        $sprintCompleted = @()
        Write-Host "Processing: $currentSprint..." -ForegroundColor Cyan
        $i++
        continue
    }

    if ($line -match '^\s*-\s*\[\s*([ x~!-])\s*\]\s*(\{\{TASK:[\d.]+\}\}.+)') {
        $status = $matches[1]
        $taskFullHeader = $matches[2]
        $taskBlock = @("- [$status] $taskFullHeader")
        
        # Collect sub-lines (details) until next task or header
        $i++
        while ($i -lt $allLines.Count -and $allLines[$i] -notmatch '^\s*-\s*\[\s*[ x~!-]\s*\]' -and $allLines[$i] -notmatch '^##') {
            if ($allLines[$i].Trim() -ne "") {
                $taskBlock += $allLines[$i]
            }
            $i++
        }
        
        $fullTaskText = $taskBlock -join "`n"
        if ($status -eq 'x') { $sprintCompleted += $fullTaskText } else { $sprintTasks += $fullTaskText }
        continue
    }
    $i++
}

if ($currentSprint -ne "" -and ($sprintTasks.Count -gt 0 -or $sprintCompleted.Count -gt 0)) {
    $specsCreated += Create-Spec -SprintNum $sprintNum -SprintName $currentSprint -Tasks $sprintTasks -CompletedTasks $sprintCompleted
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "   Complete: $specsCreated specs created" -ForegroundColor Green
Write-Host "============================================"
Write-Host ""

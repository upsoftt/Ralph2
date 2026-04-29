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

# MAX_TASKS_PER_CHUNK — максимум задач в одной spec-папке (один ralph-сессия)
# Был chunking specs/NNN/M-Title/, но dashboard (ralph-tracker-web.py) этот формат
# не понимает + overseer cleanup (filter '031-*') не удаляет chunked → накопление
# подпапок при audit-regen. Решение: всегда single specs/NNN-Title/. См. инцидент
# 2026-04-27 — спринт 31 имел 24 задачи, dashboard видел только 7.
$Script:MAX_TASKS_PER_CHUNK = 999

function Build-RunCommand {
    param([string]$SpecPath)
    return "``claude -p `"Прочитай этот файл ($SpecPath). Найди ПЕРВУЮ невыполненную задачу (где стоит [ ]). Выполни ТОЛЬКО ЕЁ ОДНУ. Строго следуй правилам из claude.md и применяй глобальные навыки (TDD, Debugging). ПОСЛЕ ВЫПОЛНЕНИЯ: 1) Обнови этот файл spec.md и корневой tasks.md, отметив только ЭТУ выполненную задачу крестиком [x]. 2) В конце выведи маркер <promise>DONE</promise>, а затем напиши блок <report>...</report>, внутри которого должен быть только строгий JSON с ключами: 'exact_task_name' (в точности скопируй строку задачи из файла), 'summary' (подробное описание того, что сделано), 'skills_used' (массив названий навыков, которые ты применил).`"``"
}

function Build-SpecContent {
    param(
        [int]$SprintNum,
        [int]$ChunkIndex,         # 0 = single (no chunking), 1+ = chunk number
        [int]$TotalChunks,        # 1 = single, M = total chunks for this sprint
        [string]$SprintName,
        [string]$SpecPath,        # relative path for run command
        [string[]]$ChunkTasks,    # tasks for THIS chunk (incomplete + completed mixed in source order)
        [string]$RefsSection
    )

    $titlePrefix = if ($ChunkIndex -ge 1) { "Спринт ${SprintNum}/${ChunkIndex}" } else { "Спринт ${SprintNum}" }
    $chunkSubtitle = if ($TotalChunks -gt 1) { " (часть ${ChunkIndex}/${TotalChunks})" } else { "" }
    $tasksText = $ChunkTasks -join "`n"
    $incompleteCount = ($ChunkTasks | Where-Object { $_ -match '^\s*-\s*\[\s*[ ~!-]\s*\]' }).Count
    $runCommand = Build-RunCommand -SpecPath $SpecPath

    # depth для ../ — chunked papers лежат на 1 уровень глубже
    $upLevels = if ($ChunkIndex -ge 1) { "../../../" } else { "../../" }

    $content = "# ${titlePrefix}: ${SprintName}${chunkSubtitle}`n`n" +
               "## Команда запуска для Ralph Runner`n" +
               $runCommand +
               "`n`n## Ссылки на контекст`n" +
               "- [Планирование](${upLevels}planning.md)`n" +
               "- [Правила](${upLevels}CLAUDE.md)`n" +
               "- [PRD](${upLevels}PRD.md)`n`n" +
               "## Tasks`n`n" +
               "$tasksText`n`n" +
               "$RefsSection" +
               "## Критерии завершения`n" +
               "- [ ] Все $incompleteCount невыполненных задач реализованы и протестированы.`n" +
               "- [ ] Файл ``tasks.md`` обновлен (поставлены [x] для завершенных пунктов).`n"
    return $content
}

function Create-Spec {
    param(
        [int]$SprintNum,
        [string]$SprintName,
        [string[]]$Tasks,
        [string[]]$CompletedTasks
    )

    # === ДЕТЕКТ СУФФИКСА `<base>/<N>` в названии (task-architect соглашение) ===
    # Пример: "AI Verification Orchestrator 029/1" → base=029, partN=1, cleanName="AI Verification Orchestrator"
    # Это означает: пользователь явно разбил логический спринт на части — соблюдаем эту разбивку,
    # создаём подпапку в specs/<base>/<N>-<cleanName>/spec.md
    $explicitPart = $null
    if ($SprintName -match '^(.*?)\s+(\d{3})/(\d+)\s*$') {
        $cleanNameForExplicit = $matches[1].Trim()
        $explicitPart = @{
            Base = $matches[2]
            N = [int]$matches[3]
            CleanName = $cleanNameForExplicit
        }
    }

    $safeName = $SprintName -replace '[<>:"/\\|?*]', ''
    $safeName = $safeName.Substring(0, [Math]::Min(50, $safeName.Length)).Trim()
    $sprintFolder = "{0:D3}" -f $SprintNum

    # Сохраняем порядок: completed сверху, потом incomplete (как в старой логике)
    $allTasks = @()
    $allTasks += $CompletedTasks
    $allTasks += $Tasks
    $totalCount = $allTasks.Count
    if ($totalCount -eq 0) { return 0 }

    # Извлечение референсов (общее для всех чанков спринта)
    $refsSection = ""
    $refsDir = Join-Path $ProjectDir "refs"
    $allTasksText = $allTasks -join "`n"
    $refLines = [regex]::Matches($allTasksText, '-\s*ref:\s*(\S+)\s*-\s*(.+)')

    # === EXPLICIT PART: специальный режим если в названии есть `<base>/<N>` ===
    if ($explicitPart) {
        $base = $explicitPart.Base
        $partN = $explicitPart.N
        $cleanSafeName = ($explicitPart.CleanName -replace '[<>:"/\\|?*]', '').Trim()
        $cleanSafeName = $cleanSafeName.Substring(0, [Math]::Min(50, $cleanSafeName.Length)).Trim()
        $sprintRoot = Join-Path $SpecsDir $base
        if (!(Test-Path $sprintRoot)) { New-Item -ItemType Directory -Path $sprintRoot | Out-Null }

        # Skip if already exists
        $partPrefix = "${partN}-"
        $existingPartDirs = Get-ChildItem -Path $sprintRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($partPrefix) }
        if ($existingPartDirs -and (Test-Path (Join-Path $existingPartDirs[0].FullName "spec.md"))) {
            Write-Host "  Skip: ${base}/$($existingPartDirs[0].Name) (exists)" -ForegroundColor Yellow
            return 0
        }

        $partDirName = "${partN}-${cleanSafeName}"
        $partDir = Join-Path $sprintRoot $partDirName
        if (!(Test-Path $partDir)) { New-Item -ItemType Directory -Path $partDir | Out-Null }
        $partSpecPath = "specs/${base}/${partDirName}/spec.md"

        # Refs для explicit-part — в свою папку (каждая часть имеет свои)
        if ($refLines.Count -gt 0) {
            $partRefsDir = Join-Path $partDir "refs"
            if (!(Test-Path $partRefsDir)) { New-Item -ItemType Directory -Path $partRefsDir | Out-Null }
            $refsSection = "`n## Референсы`n"
            foreach ($ref in $refLines) {
                $refFile = $ref.Groups[1].Value
                $refDesc = $ref.Groups[2].Value.Trim()
                $srcPath = Join-Path $refsDir $refFile
                if (Test-Path $srcPath) {
                    Copy-Item $srcPath (Join-Path $partRefsDir $refFile) -Force
                    $refsSection += "- ![$refDesc](refs/$refFile)`n"
                    Write-Host "    Ref copied: $refFile" -ForegroundColor Magenta
                } else {
                    $refsSection += "- $refFile - $refDesc (файл не найден)`n"
                }
            }
        }

        # ChunkIndex=$partN, TotalChunks=$null (часть из task-architect логики, total неизвестен скрипту)
        # Используем те же параметры Build-SpecContent но с CleanName как SprintName
        $content = Build-SpecContent -SprintNum $SprintNum -ChunkIndex $partN -TotalChunks 0 `
            -SprintName $explicitPart.CleanName -SpecPath $partSpecPath -ChunkTasks $allTasks -RefsSection $refsSection
        $specFile = Join-Path $partDir "spec.md"
        [System.IO.File]::WriteAllText($specFile, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  Created: ${base}/${partDirName} ($totalCount tasks, explicit part /$partN)" -ForegroundColor Green
        return 1
    }

    # Определяем нужно ли чанкование
    $needsChunking = $totalCount -gt $Script:MAX_TASKS_PER_CHUNK

    if (-not $needsChunking) {
        # === ОДНА ПАПКА: specs/NNN-Title/ ===
        $prefix = "${sprintFolder}-"
        $existingDirs = Get-ChildItem -Path $SpecsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($prefix) }
        if ($existingDirs -and (Test-Path (Join-Path $existingDirs[0].FullName "spec.md"))) {
            Write-Host "  Skip: $($existingDirs[0].Name) (exists for sprint $SprintNum)" -ForegroundColor Yellow
            return 0
        }
        $specDirName = "${sprintFolder}-${safeName}"
        $specDir = Join-Path $SpecsDir $specDirName
        if (!(Test-Path $specDir)) { New-Item -ItemType Directory -Path $specDir | Out-Null }
        $specPath = "specs/${specDirName}/spec.md"

        # Refs (одна папка)
        if ($refLines.Count -gt 0) {
            $specRefsDir = Join-Path $specDir "refs"
            if (!(Test-Path $specRefsDir)) { New-Item -ItemType Directory -Path $specRefsDir | Out-Null }
            $refsSection = "`n## Референсы`n"
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

        $content = Build-SpecContent -SprintNum $SprintNum -ChunkIndex 0 -TotalChunks 1 `
            -SprintName $SprintName -SpecPath $specPath -ChunkTasks $allTasks -RefsSection $refsSection
        $specFile = Join-Path $specDir "spec.md"
        [System.IO.File]::WriteAllText($specFile, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  Created: $specDir ($totalCount tasks)" -ForegroundColor Green
        return 1
    }

    # === ЧАНКОВАНИЕ: specs/NNN/M-Title/ ===

    # Защита от двойной перегенерации: если уже есть старая «единая» папка
    # specs/NNN-Title/ (с -, не /), пропускаем — пользователь должен вручную мигрировать.
    $legacyPrefix = "${sprintFolder}-"
    $legacyDirs = Get-ChildItem -Path $SpecsDir -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($legacyPrefix) }
    if ($legacyDirs) {
        Write-Host "  Skip: legacy folder exists ($($legacyDirs[0].Name)) — sprint $SprintNum has $totalCount tasks (chunking would create specs/${sprintFolder}/M-...)." -ForegroundColor Yellow
        Write-Host "        To migrate: delete legacy folder and re-run." -ForegroundColor DarkYellow
        return 0
    }

    $sprintRoot = Join-Path $SpecsDir $sprintFolder
    if (!(Test-Path $sprintRoot)) { New-Item -ItemType Directory -Path $sprintRoot | Out-Null }
    $totalChunks = [Math]::Ceiling($totalCount / $Script:MAX_TASKS_PER_CHUNK)
    $createdInThisSprint = 0

    for ($chunkIdx = 1; $chunkIdx -le $totalChunks; $chunkIdx++) {
        $start = ($chunkIdx - 1) * $Script:MAX_TASKS_PER_CHUNK
        $end = [Math]::Min($start + $Script:MAX_TASKS_PER_CHUNK, $totalCount) - 1
        $chunkTasks = $allTasks[$start..$end]

        # Skip-check: пропускаем если папка для этого чанка уже существует
        $chunkPrefix = "${chunkIdx}-"
        $existingChunkDirs = Get-ChildItem -Path $sprintRoot -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith($chunkPrefix) }
        if ($existingChunkDirs -and (Test-Path (Join-Path $existingChunkDirs[0].FullName "spec.md"))) {
            Write-Host "  Skip: ${sprintFolder}/$($existingChunkDirs[0].Name) (exists)" -ForegroundColor Yellow
            continue
        }

        $chunkDirName = "${chunkIdx}-${safeName}"
        $chunkDir = Join-Path $sprintRoot $chunkDirName
        if (!(Test-Path $chunkDir)) { New-Item -ItemType Directory -Path $chunkDir | Out-Null }
        $chunkSpecPath = "specs/${sprintFolder}/${chunkDirName}/spec.md"

        # Refs — копируем только в первый чанк (общие для спринта)
        $chunkRefsSection = ""
        if ($chunkIdx -eq 1 -and $refLines.Count -gt 0) {
            $chunkRefsDir = Join-Path $chunkDir "refs"
            if (!(Test-Path $chunkRefsDir)) { New-Item -ItemType Directory -Path $chunkRefsDir | Out-Null }
            $chunkRefsSection = "`n## Референсы`n"
            foreach ($ref in $refLines) {
                $refFile = $ref.Groups[1].Value
                $refDesc = $ref.Groups[2].Value.Trim()
                $srcPath = Join-Path $refsDir $refFile
                if (Test-Path $srcPath) {
                    Copy-Item $srcPath (Join-Path $chunkRefsDir $refFile) -Force
                    $chunkRefsSection += "- ![$refDesc](refs/$refFile)`n"
                    Write-Host "    Ref copied: $refFile" -ForegroundColor Magenta
                } else {
                    $chunkRefsSection += "- $refFile - $refDesc (файл не найден)`n"
                }
            }
        }

        $content = Build-SpecContent -SprintNum $SprintNum -ChunkIndex $chunkIdx -TotalChunks $totalChunks `
            -SprintName $SprintName -SpecPath $chunkSpecPath -ChunkTasks $chunkTasks -RefsSection $chunkRefsSection
        $specFile = Join-Path $chunkDir "spec.md"
        [System.IO.File]::WriteAllText($specFile, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  Created: ${sprintFolder}/${chunkDirName} ($($chunkTasks.Count) tasks)" -ForegroundColor Green
        $createdInThisSprint++
    }
    return $createdInThisSprint
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

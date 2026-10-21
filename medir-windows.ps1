# Actividad 4 · Plan B para Windows sin Docker: mismas mediciones con los contadores de Windows.
# Correr en PowerShell MIENTRAS la carga está andando:
#   powershell -ExecutionPolicy Bypass -File medir-windows.ps1
# Usa clases CIM (nombres en inglés aunque Windows esté en español).
# Windows no tiene "wa" (iowait): se reporta la cola del disco, que es la señal equivalente.

$dir = "datos\actividad4"
New-Item -ItemType Directory -Force $dir | Out-Null

$srv = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*servidor.js*' } | Select-Object -First 1
if (-not $srv) { Write-Host "No encuentro 'node servidor.js'. ¿Está corriendo la API?"; exit 1 }
$procId = $srv.ProcessId
$nucleos = [Environment]::ProcessorCount

function Tomar([int]$n) {
  $archivo = "$dir\medicion-$n-windows.txt"
  $filas = @()
  $p0 = Get-Process -Id $procId; $t0 = Get-Date
  for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Seconds 1
    $cpu  = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor
    $tot  = $cpu | Where-Object Name -eq '_Total'
    $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
    $filas += [pscustomobject]@{
      us   = [double]$tot.PercentUserTime
      sy   = [double]$tot.PercentPrivilegedTime
      id   = [double]$tot.PercentIdleTime
      util = [math]::Max(0, [math]::Min(100, 100 - [double]$disk.PercentIdleTime))
      cola = [double]$disk.AvgDiskQueueLength
      escr = [double]$disk.DiskWritesPersec
      nucleos = ($cpu | Where-Object Name -ne '_Total' | Sort-Object { [int]$_.Name } |
                 ForEach-Object { "$($_.Name):$($_.PercentProcessorTime)%" }) -join '  '
    }
  }
  $p1 = Get-Process -Id $procId; $t1 = Get-Date
  # %CPU del proceso en "% de un núcleo" (100 = un núcleo lleno), como en top.
  $procCpu = 100 * ($p1.TotalProcessorTime - $p0.TotalProcessorTime).TotalSeconds / ($t1 - $t0).TotalSeconds
  $prom = { param($c) [math]::Round(($filas | Measure-Object -Property $c -Average).Average, 1) }

  $res = @"
===== Medición $n · $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') · PID $procId · $nucleos núcleos lógicos =====
Muestras (1 por segundo):
$($filas | Format-Table us, sy, id, util, cola, escr -AutoSize | Out-String)
Por núcleo (última muestra): $($filas[-1].nucleos)

===== RESUMEN medición $n =====
CPU usuario (us):      $(& $prom 'us') %     [Processor(_Total) % User Time]
CPU sistema (sy):      $(& $prom 'sy') %     [Processor(_Total) % Privileged Time]
Espera E/S (wa):       no existe en Windows · cola de disco promedio = $(& $prom 'cola')
Ocioso (id):           $(& $prom 'id') %     [Processor(_Total) % Idle Time]
RES del proceso:       $([math]::Round($p1.WorkingSet64 / 1MB, 1)) MB  [Working Set] · %CPU del proceso: $([math]::Round($procCpu, 1))
Disco %util:           $(& $prom 'util') %     [100 - PhysicalDisk % Idle Time] · escrituras/s: $(& $prom 'escr')
"@
  $res | Tee-Object -FilePath $archivo
  Write-Host "Guardado en $archivo"
}

Tomar 1
Write-Host "`nEsperando 60 s para la segunda medición (no detengan la carga)..."
Start-Sleep -Seconds 60
Tomar 2

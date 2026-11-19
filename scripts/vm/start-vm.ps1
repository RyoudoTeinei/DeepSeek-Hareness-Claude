param([ValidateSet('bootstrap','isolated')][string]$Network='isolated')
$ErrorActionPreference='Stop'
$configPath=Join-Path $PSScriptRoot 'instance\vm.json'
$cfg=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$policyFile=Join-Path $cfg.directory 'power-policy.json'
if(Test-Path -LiteralPath $policyFile){$policy=Get-Content -LiteralPath $policyFile -Raw | ConvertFrom-Json;if($policy.manualOff){throw 'VM was manually powered off. Use the updated DSH Start VM or Connect action.'}}
$pidFile=Join-Path $cfg.directory 'qemu.pid'
if(Test-Path -LiteralPath $pidFile){
 $vmPid=(Get-Content -LiteralPath $pidFile -Raw).Trim()
 if($vmPid -match '^\d+$'){
  $running=Get-CimInstance Win32_Process -Filter "ProcessId = $vmPid" -ErrorAction Stop
  if($running -and $running.ExecutablePath -eq $cfg.qemu -and $running.CommandLine -like ('*'+$cfg.instanceId+'*')){
   if($Network -eq 'isolated' -and $running.CommandLine -notlike '*restrict=on*'){throw 'Existing VM is not isolated; shut it down before reconnecting'}
   Write-Output ('Dedicated VM is already running: '+$vmPid);exit 0
  }
 }
}
$disk=(Join-Path $cfg.directory 'disk.qcow2').Replace('\','/')
$seed=(Join-Path $cfg.directory 'seed.iso').Replace('\','/')
$serial=(Join-Path $cfg.directory 'boot.log').Replace('\','/')
$argsList=@('-name','dsh-vm-executor','-uuid',$cfg.instanceId,'-machine','q35,accel=whpx,kernel-irqchip=off','-cpu','qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt','-m',[string]$cfg.memoryMiB,'-smp',[string]$cfg.cpus,'-display','none','-monitor','none','-serial',('file:'+$serial),'-qmp',('tcp:127.0.0.1:'+$cfg.qmpPort+',server=on,wait=off'),'-drive',('file='+$disk+',if=virtio,format=qcow2'),'-drive',('file='+$seed+',media=cdrom,readonly=on'),'-netdev',('user,id=net0,hostfwd=tcp:127.0.0.1:'+$cfg.sshPort+'-:22'+$(if($Network -eq 'isolated'){',restrict=on'}else{''})),'-device','virtio-net-pci,netdev=net0','-pidfile',$pidFile)
# All generated runtime paths have no spaces; refuse unsafe command-line splitting.
if($argsList | Where-Object {$_ -match '\s'}){throw 'Runtime arguments contain whitespace; use a path without spaces'}
$process=Start-Process -FilePath $cfg.qemu -ArgumentList $argsList -WorkingDirectory (Split-Path $cfg.qemu) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $cfg.directory 'qemu.stdout.log') -RedirectStandardError (Join-Path $cfg.directory 'qemu.stderr.log') -PassThru
$cfg.network=$Network
$cfg | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
Write-Output ('Started dedicated VM PID '+$process.Id+' in '+$Network+' mode')

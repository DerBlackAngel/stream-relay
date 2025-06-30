const { exec } = require('child_process');

const CHECK_INTERVAL = 5000; // 5 Sekunden

function ensureLoopRunning() {
  exec('docker inspect -f "{{.State.Running}}" ffmpeg-loop', (err, stdout) => {
    if (err || stdout.trim() !== 'true') {
      console.warn('🔄 BRB-Loop ist nicht aktiv – starte...');
      exec('docker start ffmpeg-loop', (startErr) => {
        if (startErr) {
          console.error('❌ Fehler beim Start von ffmpeg-loop:', startErr);
        } else {
          console.log('✅ BRB wurde gestartet.');
        }
      });
    } else {
      console.log('✅ BRB läuft.');
    }
  });
}

function checkRunner() {
  exec('docker inspect -f "{{.State.Running}}" ffmpeg-runner', (err, stdout) => {
    if (err || stdout.trim() !== 'true') {
      console.warn('⚠️ ffmpeg-runner ist nicht aktiv. Stelle sicher, dass BRB aktiv ist...');
      ensureLoopRunning();
    } else {
      console.log('✅ ffmpeg-runner läuft.');
    }
  });
}

console.log('🛡️ Stream-Guard gestartet. Überwache ffmpeg-runner und sichere BRB...');
setInterval(checkRunner, CHECK_INTERVAL);
ensureLoopRunning();

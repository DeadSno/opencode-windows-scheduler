const { createTask } = require('./dist/schtasks.js');

async function main() {
  try {
    await createTask(
      'Regress-Final',
      '"C:\\Users\\TshK\\AppData\\Roaming\\opencode\\windows-scheduler\\wrappers\\run-Regress-Final.cmd"',
      ['/sc', 'MINUTE', '/mo', '1']
    );
    console.log('OK: task created');
  } catch (e) {
    console.error('ERR:', e.message);
    console.error('STDERR:', e.stderr);
    console.error('CODE:', e.code);
  }
}

main();

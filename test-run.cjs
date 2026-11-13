const { runSchtasks } = require('./dist/schtasks.js');

async function main() {
  const args = ["/create", "/tn", "\\OpenCode\\windows-scheduler\\Regress-Final", "/tr", "\"C:\\Users\\TshK\\AppData\\Roaming\\opencode\\windows-scheduler\\wrappers\\run-Regress-Final.cmd\"", "/sc", "MINUTE", "/mo", "1", "/f"];
  console.log("ARGS:", args.join(" "));
  try {
    const result = await runSchtasks(args);
    console.log("RESULT CODE:", result.code);
    console.log("STDOUT:", JSON.stringify(result.stdout));
    console.log("STDERR:", JSON.stringify(result.stderr));
  } catch (e) {
    console.error("THROWN:", e.message);
    console.error("CODE:", e.code);
    console.error("STDERR:", JSON.stringify(e.stderr));
  }
}

main();

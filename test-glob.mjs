/**
 * Тесты Спринта 27: dependency-free glob-матчер (src/core/glob.ts).
 * Запуск: node test-glob.mjs (после npm run build).
 */
import {
  normalizePath,
  globToRegExp,
  matchesGlob,
  matchesAnyGlob,
  isIgnored,
  filterPaths,
  relativeTo,
} from "./dist/core/glob.js";

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}`);
}

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- 1. normalizePath --------------------------------------------------------
check("normalizePath 'src\\\\file.ts' → 'src/file.ts'", normalizePath("src\\file.ts") === "src/file.ts");
check("normalizePath './src/file' → 'src/file'", normalizePath("./src/file") === "src/file");
check("normalizePath 'a//b' → 'a/b'", normalizePath("a//b") === "a/b");
check("normalizePath '' → ''", normalizePath("") === "");

// --- 2. globToRegExp (anchored) ----------------------------------------------
check("*' подходит 'hello.txt'", /^[^/]*$/.test("hello.txt") && globToRegExp("*").test("hello.txt"));
check("'src/*.ts' не подходит 'src/sub/a.ts'", !globToRegExp("src/*.ts").test("src/sub/a.ts"));
check("'src/*.ts' подходит 'src/a.ts'", globToRegExp("src/*.ts").test("src/a.ts"));
check("'**' подходит любой путь", globToRegExp("**").test("a/b/c/d.ts"));
check("'**/*.md' подходит 'docs/readme.md'", globToRegExp("**/*.md").test("docs/readme.md"));
check("'**/*.md' подходит 'readme.md'", globToRegExp("**/*.md").test("readme.md"));
check("'?' подходит один символ (не /)", globToRegExp("?.ts").test("a.ts") && !globToRegExp("?.ts").test("ab.ts"));
check("'[abc]' класс символов", globToRegExp("[abc]").test("b") && !globToRegExp("[abc]").test("d"));
check("'[!abc]' отрицание класса", globToRegExp("[!abc]").test("d") && !globToRegExp("[!abc]").test("a"));
check("'{a,b}' альтернатива", globToRegExp("{a,b}").test("a") && globToRegExp("{a,b}").test("b") && !globToRegExp("{a,b}").test("c"));
check("escaped '.' в маске", globToRegExp("file.txt").test("file.txt") && !globToRegExp("file.txt").test("filetxt"));
check("регистронезависимость на win32", globToRegExp("SRC").test("src"));

// --- 3. matchesGlob ----------------------------------------------------------
check("matchesGlob 'src/a.ts' по 'src/*.ts'", matchesGlob("src/a.ts", "src/*.ts"));
check("matchesGlob 'src/sub/a.ts' НЕ по 'src/*.ts'", !matchesGlob("src/sub/a.ts", "src/*.ts"));
check("matchesGlob 'a/b/c' по '**'", matchesGlob("a/b/c", "**"));
check("matchesGlob каталога 'src' по 'src/**'", matchesGlob("src", "src/**"));
check("matchesGlob 'src/sub/x.ts' по 'src/**'", matchesGlob("src/sub/x.ts", "src/**"));
check("matchesGlob '' по чему-либо → false", !matchesGlob("", "*"));

// --- 4. matchesAnyGlob (с ! отрицанием) --------------------------------------
check("matchesAnyGlob по списку", matchesAnyGlob("src/a.ts", ["src/*.ts", "docs/*.md"]));
check("matchesAnyGlob ! исключает последним", matchesAnyGlob("src/a.ts", ["src/*.ts", "!src/a.ts"]) === false);
check("matchesAnyGlob ! затем include снова", matchesAnyGlob("src/b.ts", ["src/*.ts", "!src/a.ts"]) === true);
check("matchesAnyGlob пустой список → false", !matchesAnyGlob("anything", []));
check("matchesAnyGlob не-массив → false", !matchesAnyGlob("anything", "src/*.ts"));

// --- 5. isIgnored ------------------------------------------------------------
check("isIgnored 'node_modules/x' по ['node_modules/**']", isIgnored("node_modules/x", ["node_modules/**"]));
check("isIgnored 'src/x' по ['node_modules/**'] → false", !isIgnored("src/x", ["node_modules/**"]));
check("isIgnored пустой список → false", !isIgnored("anything", []));
check("isIgnored не-массив → false", !isIgnored("anything", "node_modules/**"));

// --- 6. filterPaths ----------------------------------------------------------
check("filterPaths без include = все (кроме ignore)", filterPaths(["a.ts", "b.log", "c.md"], undefined, ["*.log"]).join(",") === "a.ts,c.md");
check("filterPaths с include", filterPaths(["a.ts", "b.js", "c.md"], ["*.ts", "*.md"]).join(",") === "a.ts,c.md");
check("filterPaths include + ignore", filterPaths(["a.ts", "b.ts", "c.log"], ["*.ts"], ["a.ts"]).join(",") === "b.ts");
check("filterPaths пустой массив файлов → []", filterPaths([], ["*"]).length === 0);

// --- 7. relativeTo -----------------------------------------------------------
check("relativeTo 'src' 'src/file.ts' → 'file.ts'", relativeTo("src", "src/file.ts") === "file.ts");
check("relativeTo 'src' 'src/sub/file.ts' → 'sub/file.ts'", relativeTo("src", "src/sub/file.ts") === "sub/file.ts");
check("relativeTo вне каталога → null", relativeTo("src", "other/file.ts") === null);
check("relativeTo каталога сам в себя → ''", relativeTo("src", "src") === "");
check("relativeTo без базы → путь", relativeTo("", "a/b.ts") === "a/b.ts");

// --- 8. гранцы классов [a-z] -------------------------------------------------
check("matchesGlob 'm' по '[a-z]'", matchesGlob("m", "[a-z]"));
check("matchesGlob '5' по '[a-z]' → false", !matchesGlob("5", "[a-z]"));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} OK`);
if (failed.length > 0) {
  console.error(`Провалено: ${failed.map((r) => r.name).join("; ")}`);
  process.exit(1);
}

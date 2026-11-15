// node:sqlite is stable enough for the embedding cache, but Node still prints
// an ExperimentalWarning to stderr the first time it loads. The filter has to
// run before the bundled imports, hence a banner rather than source code.
export const quietSqliteWarning = `(() => {
  const emitWarning = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning && warning.message;
    if (typeof text === "string" && text.includes("SQLite is an experimental feature")) return;
    return emitWarning.call(this, warning, ...rest);
  };
})();`;

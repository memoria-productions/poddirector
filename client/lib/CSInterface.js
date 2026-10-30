/* Minimal CSInterface shim: the few calls PodCutter needs from Adobe's CEP runtime. */
function CSInterface() {}
CSInterface.prototype.evalScript = function (script, cb) {
  cb = cb || function () {};
  if (!window.__adobe_cep__) return cb("EvalScript error: not running in Premiere");
  window.__adobe_cep__.evalScript(script, cb);
};
/* CEP hands some paths back as file:/// URLs; turn them into normal file-system paths. */
function cepPath(p) {
  if (!p) return null;
  p = String(p);
  if (p.indexOf("file:") === 0) p = decodeURIComponent(p.replace(/^file:\/*/, process.platform === "win32" ? "" : "/"));
  if (process.platform === "win32") p = p.replace(/\//g, "\\");
  return p;
}
CSInterface.prototype.getExtensionPath = function () {
  if (!window.__adobe_cep__) return null;
  return cepPath(window.__adobe_cep__.getSystemPath("extension"));
};
CSInterface.prototype.getUserDocuments = function () {
  if (!window.__adobe_cep__) return null;
  return cepPath(window.__adobe_cep__.getSystemPath("myDocuments"));
};
CSInterface.prototype.openURL = function (url) {
  if (window.cep && window.cep.util) window.cep.util.openURLInDefaultBrowser(url);
};

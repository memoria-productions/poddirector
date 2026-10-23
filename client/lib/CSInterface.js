/* Minimal CSInterface shim: the few calls PodDirector needs from Adobe's CEP runtime. */
function CSInterface() {}
CSInterface.prototype.evalScript = function (script, cb) {
  cb = cb || function () {};
  if (!window.__adobe_cep__) return cb("EvalScript error: not running in Premiere");
  window.__adobe_cep__.evalScript(script, cb);
};
CSInterface.prototype.getExtensionPath = function () {
  if (!window.__adobe_cep__) return null;
  var p = window.__adobe_cep__.getSystemPath("extension");
  if (p && p.indexOf("file:") === 0) { p = decodeURIComponent(p.replace(/^file:\/*/, process.platform === "win32" ? "" : "/")); }
  return p;
};
CSInterface.prototype.getUserDocuments = function () {
  if (!window.__adobe_cep__) return null;
  return window.__adobe_cep__.getSystemPath("myDocuments");
};
CSInterface.prototype.openURL = function (url) {
  if (window.cep && window.cep.util) window.cep.util.openURLInDefaultBrowser(url);
};

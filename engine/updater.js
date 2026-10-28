/*
 * PodDirector — self-updater (Windows).
 *
 * Looks for a newer release in two places:
 *   - GitHub Releases of the PodDirector repo (works when the repo is public)
 *   - an update folder, e.g. a shared network drive, holding PodDirector-x.y.z-Windows.zip files
 * and installs it by unzipping the package and running its install.ps1 -Silent, which mirrors
 * the new files over the installed extension. Reopening the panel loads the new files; Premiere only needs
 * a restart when the manifest changed (beyond its version numbers), since it reads that at startup.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.PodUpdater = api;
  else if (root) root.PodUpdater = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var req = typeof require === "function" ? require : null;
  var fs = req && req("fs"), path = req && req("path"), os = req && req("os"), cp = req && req("child_process"), https = req && req("https");

  var DEFAULT_REPO = "memoria-productions/poddirector";
  var ZIP_RE = /^PodDirector-(\d+\.\d+\.\d+)-Windows\.zip$/i;

  function cmp(a, b) {
    var x = String(a).replace(/^v/, "").split("."), y = String(b).replace(/^v/, "").split(".");
    for (var i = 0; i < 3; i++) { var d = (+x[i] || 0) - (+y[i] || 0); if (d) return d > 0 ? 1 : -1; }
    return 0;
  }

  function getJson(url) {
    return new Promise(function (resolve, reject) {
      var r = https.get(url, { headers: { "User-Agent": "PodDirector-updater", Accept: "application/vnd.github+json" } }, function (res) {
        var body = "";
        res.on("data", function (d) { body += d; });
        res.on("end", function () {
          if (res.statusCode === 404) return reject(new Error("No public release found (the repository may be private: use an update folder instead)."));
          if (res.statusCode !== 200) return reject(new Error("GitHub answered " + res.statusCode));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      });
      r.on("error", reject);
      r.setTimeout(15000, function () { r.destroy(new Error("GitHub did not respond")); });
    });
  }

  /** Latest release on GitHub: { version, url, notes, source } */
  function checkGitHub(repo) {
    return getJson("https://api.github.com/repos/" + (repo || DEFAULT_REPO) + "/releases/latest").then(function (rel) {
      var asset = (rel.assets || []).filter(function (a) { return ZIP_RE.test(a.name); })[0];
      if (!asset) throw new Error("The latest release has no Windows package attached yet.");
      return { version: ZIP_RE.exec(asset.name)[1], url: asset.browser_download_url, size: asset.size,
        notes: rel.body || "", page: rel.html_url, source: "GitHub" };
    });
  }

  /** Newest PodDirector-x.y.z-Windows.zip in a folder: { version, file, source } */
  function checkFolder(dir) {
    return new Promise(function (resolve, reject) {
      fs.readdir(dir, function (err, files) {
        if (err) return reject(new Error("Can't read update folder " + dir + ": " + err.message));
        var best = null;
        files.forEach(function (f) {
          var m = ZIP_RE.exec(f);
          if (m && (!best || cmp(m[1], best.version) > 0)) best = { version: m[1], file: path.join(dir, f), source: "update folder" };
        });
        if (!best) return reject(new Error("No PodDirector-x.y.z-Windows.zip in " + dir));
        resolve(best);
      });
    });
  }

  /** Check every configured source; resolves the newest found (or null) plus any errors. */
  function check(opts) {
    var jobs = [];
    if (opts.folder) jobs.push(checkFolder(opts.folder).then(function (r) { return r; }, function (e) { return { error: e.message }; }));
    if (opts.github !== false) jobs.push(checkGitHub(opts.repo).then(function (r) { return r; }, function (e) { return { error: "GitHub: " + e.message }; }));
    return Promise.all(jobs).then(function (rs) {
      var found = rs.filter(function (r) { return r.version; }).sort(function (a, b) { return cmp(b.version, a.version); });
      var latest = found[0] || null;
      return { current: opts.current, latest: latest, newer: !!(latest && cmp(latest.version, opts.current) > 0),
               errors: rs.filter(function (r) { return r.error; }).map(function (r) { return r.error; }) };
    });
  }

  function download(url, dest, onProgress, hops) {
    return new Promise(function (resolve, reject) {
      if ((hops || 0) > 5) return reject(new Error("Too many redirects"));
      https.get(url, { headers: { "User-Agent": "PodDirector-updater" } }, function (res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, onProgress, (hops || 0) + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("Download failed (" + res.statusCode + ")")); }
        var total = +res.headers["content-length"] || 0, got = 0;
        var out = fs.createWriteStream(dest);
        res.on("data", function (d) { got += d.length; if (onProgress && total) onProgress(got / total); });
        res.pipe(out);
        out.on("finish", function () { out.close(function () { resolve(dest); }); });
        out.on("error", reject);
      }).on("error", reject);
    });
  }

  function run(cmd, args) {
    return new Promise(function (resolve, reject) {
      var p = cp.spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      var out = "";
      p.stdout.on("data", function (d) { out += d; });
      p.stderr.on("data", function (d) { out += d; });
      p.on("error", reject);
      p.on("close", function (code) { code === 0 ? resolve(out) : reject(new Error(out.trim().split(/\r?\n/).slice(-4).join(" ") || "exit " + code)); });
    });
  }

  /** The manifest without its version numbers and layout: two equal signatures need no Premiere restart. */
  function manifestSignature(xml) {
    return String(xml)
      .replace(/(ExtensionBundleVersion|Version)="\d+\.\d+\.\d+"/g, '$1=""')
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\s+/g, " ").trim();
  }

  /** Does going from the installed manifest to the package's one need a Premiere restart? Unknown = yes. */
  function needsRestart(installedManifest, newManifest) {
    try {
      return manifestSignature(fs.readFileSync(installedManifest, "utf8")) !== manifestSignature(fs.readFileSync(newManifest, "utf8"));
    } catch (e) { return true; }
  }

  /**
   * Download (if needed), unpack and install an update. Windows only.
   * release: result of check().latest; onProgress(stage, fraction); opts.extensionRoot: the installed extension
   * Resolves { version, log, needsRestart }.
   */
  function install(release, onProgress, opts) {
    opts = opts || {};
    var restart = true;
    if (process.platform !== "win32") return Promise.reject(new Error("Automatic install is only available on Windows."));
    onProgress = onProgress || function () {};
    var work = fs.mkdtempSync(path.join(os.tmpdir(), "poddirector-update-"));
    var zip = path.join(work, "PodDirector-" + release.version + "-Windows.zip");
    var get = release.file
      ? new Promise(function (resolve, reject) { onProgress("copy", 0); fs.copyFile(release.file, zip, function (e) { e ? reject(e) : resolve(zip); }); })
      : download(release.url, zip, function (f) { onProgress("download", f); });
    var ps = "powershell.exe";
    return get.then(function () {
      onProgress("unpack", 0);
      return run(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
        "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + work.replace(/'/g, "''") + "\\x' -Force"]);
    }).then(function () {
      var top = fs.readdirSync(path.join(work, "x")).map(function (f) { return path.join(work, "x", f); })
        .filter(function (f) { return fs.existsSync(path.join(f, "install.ps1")); })[0];
      if (!top) throw new Error("The update package has no installer in it.");
      // Compare manifests before the installer overwrites the old one.
      if (opts.extensionRoot) restart = needsRestart(path.join(opts.extensionRoot, "CSXS", "manifest.xml"), path.join(top, "PodDirector", "CSXS", "manifest.xml"));
      onProgress("install", 0);
      return run(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(top, "install.ps1"), "-Silent"]);
    }).then(function (log) {
      try { fs.rmSync ? fs.rmSync(work, { recursive: true, force: true }) : null; } catch (e) { /* temp cleanup is best-effort */ }
      onProgress("done", 1);
      return { version: release.version, log: log, needsRestart: restart };
    });
  }

  return { DEFAULT_REPO: DEFAULT_REPO, compare: cmp, check: check, checkGitHub: checkGitHub, checkFolder: checkFolder, install: install,
           manifestSignature: manifestSignature, needsRestart: needsRestart };
});

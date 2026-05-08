// Runs after electron-builder signs the .app. Submits the bundle to
// Apple's notary service and staples the ticket so Gatekeeper accepts
// it on first launch without phoning home.
//
// Required env (set in CI / local):
//   APPLE_ID                  Apple ID email
//   APPLE_APP_SPECIFIC_PASSWORD  app-specific password from appleid.apple.com
//   APPLE_TEAM_ID             10-char team id (e.g. ABC123DEFG)
//
// If any of these are missing we skip notarization with a warning so
// `npm run build` keeps working for unsigned local builds.

const path = require('node:path');

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn(
      '[notarize] Skipping — set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID to enable.',
    );
    return;
  }

  const { notarize } = await import('@electron/notarize');
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] Submitting ${appPath} to Apple…`);
  await notarize({
    appBundleId: 'com.airshelf.app',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] Done — ticket stapled.');
};

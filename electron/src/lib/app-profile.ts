/**
 * Keep AstraDock on the existing Harnss profile after the product rename.
 * Import this module before any module that reads settings, starts logging,
 * or obtains an Electron session. Storage names are compatibility identifiers.
 */
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

// Packaged smoke tests and other isolated launches explicitly choose a profile.
const requestedProfile = app.commandLine.getSwitchValue("user-data-dir");
const profilePath = requestedProfile
  ? path.resolve(requestedProfile)
  : path.join(app.getPath("appData"), "Harnss");

// Electron requires an existing directory when overriding its special paths.
// Fail before consumers start if it cannot be created, rather than using an
// empty profile under the renamed product and hiding existing user data.
fs.mkdirSync(profilePath, { recursive: true });
app.setPath("userData", profilePath);

// Chromium stores cookies, localStorage and persistent browser partitions here.
// Set it explicitly before ready; changing userData alone does not guarantee
// that Chromium follows the same profile directory.
app.setPath("sessionData", profilePath);

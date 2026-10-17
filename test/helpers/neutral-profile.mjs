// Import FIRST in a test file that must see the shipped, brand-neutral profile. `npm test` already
// points the user dir at nothing; a plain `node --test test/x.test.mjs` would otherwise read the
// creator's ~/.config/capcutctl/profile.json (its ending, headline, brand) into the fixtures.
// Child processes inherit it. Tests that need a user layer still set CAPCUTCTL_PRESET_DIR themselves.
delete process.env.CAPCUTCTL_PRESET_DIR;
process.env.XDG_CONFIG_HOME = '/nonexistent/capcutctl-test';

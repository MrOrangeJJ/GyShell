import assert from "node:assert/strict";
import { MacOSPermissionService } from "./MacOSPermissionService";

const createStore = (
  initialVersion?: string,
) => {
  let promptedVersion = initialVersion;
  let checkedInstallation: string | undefined;
  return {
    getSettings: () => ({
      macosFullDiskAccessPromptedVersion: promptedVersion,
      macosFullDiskAccessCheckedInstallation: checkedInstallation,
    }),
    setSettings: (settings: {
      macosFullDiskAccessPromptedVersion?: string;
      macosFullDiskAccessCheckedInstallation: string;
    }) => {
      promptedVersion =
        settings.macosFullDiskAccessPromptedVersion ?? promptedVersion;
      checkedInstallation = settings.macosFullDiskAccessCheckedInstallation;
    },
    getPromptedVersion: () => promptedVersion,
    getCheckedInstallation: () => checkedInstallation,
  };
};

{
  const store = createStore();
  const service = new MacOSPermissionService(
    store,
    "darwin",
    "1.7.0",
    ["/path/that/does/not/exist"],
  );
  const first = await service.getFullDiskAccessState();
  assert.equal(first.shouldPrompt, true);
  assert.equal(store.getPromptedVersion(), "1.7.0");
  assert.ok(store.getCheckedInstallation());

  const second = await service.getFullDiskAccessState();
  assert.equal(second.shouldPrompt, false);
}

{
  const store = createStore("1.7.0");
  const service = new MacOSPermissionService(
    store,
    "darwin",
    "1.7.0",
    ["/path/that/does/not/exist"],
  );
  const state = await service.getFullDiskAccessState();
  assert.equal(state.granted, false);
  assert.equal(
    state.shouldPrompt,
    true,
    "legacy version-only markers should be checked once by the new installation-aware logic",
  );
}

{
  const store = createStore("1.7.0");
  const firstInstall = new MacOSPermissionService(
    store,
    "darwin",
    "1.7.0",
    ["/path/that/does/not/exist"],
    ["/installation-v1"],
  );
  await firstInstall.getFullDiskAccessState();
  const updatedInstall = new MacOSPermissionService(
    store,
    "darwin",
    "1.7.0",
    ["/path/that/does/not/exist"],
    ["/installation-v2"],
  );
  const state = await updatedInstall.getFullDiskAccessState();
  assert.equal(state.shouldPrompt, true);
  const second = await updatedInstall.getFullDiskAccessState();
  assert.equal(
    second.shouldPrompt,
    false,
    "the same installation should not prompt again after the first check",
  );
}

{
  const store = createStore();
  const service = new MacOSPermissionService(store, "linux", "1.7.0", ["/tmp"]);
  const state = await service.getFullDiskAccessState();
  assert.deepEqual(state, {
    supported: false,
    granted: true,
    shouldPrompt: false,
    promptedVersion: null,
  });
}

console.log("MacOSPermissionService extreme tests passed");

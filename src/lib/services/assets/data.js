import { getHash } from '@sveltia/utils/crypto';
import { getPathInfo } from '@sveltia/utils/file';
import { get, writable } from 'svelte/store';
import {
  allAssetFolders,
  allAssets,
  focusedAsset,
  getAssetBlob,
  getAssetKind,
  getAssetPublicURL,
  getAssetsByDirName,
  overlaidAsset,
} from '$lib/services/assets';
import { backend, backendName } from '$lib/services/backends';
import { siteConfig } from '$lib/services/config';
import { allEntries, getCollection, getEntriesByAssetURL } from '$lib/services/contents';
import { createSavingEntryData } from '$lib/services/contents/draft/save';
import { renameIfNeeded } from '$lib/services/utils/file';

/**
 * @type {import('svelte/store').Writable<UpdatesToastState>}
 */
export const assetUpdatesToast = writable({
  count: 1,
  saved: false,
  moved: false,
  renamed: false,
  deleted: false,
  published: false,
});

/**
 * Upload/save the given assets to the backend.
 * @param {UploadingAssets} uploadingAssets - Assets to be uploaded.
 * @param {CommitChangesOptions} options - Options for the backend handler.
 */
export const saveAssets = async (uploadingAssets, options) => {
  const { files, folder, originalAsset } = uploadingAssets;
  const assetNamesInSameFolder = folder ? getAssetsByDirName(folder).map((a) => a.name) : [];

  const savingFileList = files.map((file) => {
    const name =
      originalAsset?.name ?? renameIfNeeded(file.name.normalize(), assetNamesInSameFolder);

    if (!assetNamesInSameFolder.includes(name)) {
      assetNamesInSameFolder.push(name);
    }

    return {
      action: /** @type {CommitAction} */ (originalAsset ? 'update' : 'create'),
      name,
      path: [folder, name].join('/'),
      file,
    };
  });

  await get(backend)?.commitChanges(
    savingFileList.map(({ action, path, file }) => ({ action, path, data: file })),
    options,
  );

  const { collectionName } =
    get(allAssetFolders).findLast(({ internalPath }) => folder === internalPath) ?? {};

  /**
   * @type {Asset[]}
   */
  const newAssets = await Promise.all(
    savingFileList.map(
      async ({ name, path, file }) =>
        /** @type {Asset} */ ({
          blobURL: URL.createObjectURL(file),
          name,
          path,
          sha: await getHash(file),
          size: file.size,
          kind: getAssetKind(name),
          text: undefined,
          collectionName,
          folder,
        }),
    ),
  );

  allAssets.update((assets) => [
    ...assets.filter((a) => !newAssets.some((na) => na.path === a.path)),
    ...newAssets,
  ]);

  const _focusedAsset = get(focusedAsset);
  const _overlaidAsset = get(overlaidAsset);

  // Replace the existing asset
  if (_focusedAsset) {
    focusedAsset.set(get(allAssets).find((a) => a.path === _focusedAsset.path));
  }

  // Replace the existing asset
  if (_overlaidAsset) {
    overlaidAsset.set(get(allAssets).find((a) => a.path === _overlaidAsset.path));
  }

  const isLocal = get(backendName) === 'local';

  const { backend: { automatic_deployments: autoDeployEnabled = undefined } = {} } =
    get(siteConfig) ?? /** @type {SiteConfig} */ ({});

  assetUpdatesToast.set({
    count: files.length,
    saved: true,
    published: !isLocal && autoDeployEnabled === true,
  });
};

/**
 * Move or rename assets while updating links in the entries.
 * @param {'move' | 'rename'} action - Action type.
 * @param {MovingAsset[]} movingAssets - Assets to be moved/renamed.
 */
export const moveAssets = async (action, movingAssets) => {
  const _allAssetFolders = get(allAssetFolders);
  /** @type {FileChange[]} */
  const changes = [];
  /** @type {Entry[]} */
  const savingEntries = [];
  /** @type {Asset[]} */
  const savingAssets = [];

  await Promise.all(
    movingAssets.map(async ({ asset, path }) => {
      const newPath = path;
      const newName = getPathInfo(newPath).basename;

      savingAssets.push({ ...asset, path: newPath, name: newName });

      changes.push({
        action: 'move',
        path: newPath,
        previousPath: asset.path,
        data: new File([asset.file ?? (await getAssetBlob(asset))], newName),
      });

      const assetURL = asset.blobURL ?? getAssetPublicURL(asset);
      const usedEntries = assetURL ? await getEntriesByAssetURL(assetURL) : [];

      if (!assetURL || !usedEntries.length) {
        return;
      }

      const { publicPath } =
        _allAssetFolders.find(({ collectionName }) => collectionName === asset.collectionName) ??
        _allAssetFolders.find(({ collectionName }) => collectionName === null) ??
        {};

      const updatedEntries = await getEntriesByAssetURL(assetURL, {
        entries: structuredClone(usedEntries),
        newURL: newPath.replace(asset.folder, publicPath ?? ''),
      });

      await Promise.all(
        updatedEntries.map(async (entry) => {
          const { collectionName, fileName, locales, slug } = entry;
          const collection = /** @type {Collection} */ (getCollection(collectionName));

          const originalLocales = Object.fromEntries(
            Object.keys(locales).map((locale) => [locale, true]),
          );

          const { savingEntry, changes: savingEntryChanges } = await createSavingEntryData({
            isNew: false,
            collection,
            collectionFile: fileName ? collection._fileMap?.[fileName] : undefined,
            defaultLocaleSlug: slug,
            originalLocales,
            currentLocales: originalLocales,
            localizedEntryMap: locales,
          });

          savingEntries.push(savingEntry);
          changes.push(...savingEntryChanges);
        }),
      );
    }),
  );

  const results = await get(backend)?.commitChanges(changes, { commitType: 'uploadMedia' });

  // Update blob URLs for the local backend
  if (Array.isArray(results)) {
    savingAssets.forEach((asset, index) => {
      if (results[index] instanceof File) {
        asset.blobURL = URL.createObjectURL(/** @type {File} */ (results[index]));
      }
    });
  }

  const savingAssetsPaths = movingAssets.map((a) => a.asset.path); // old paths
  const savingEntryIds = savingEntries.map((e) => e.id);

  allAssets.update((assets) => [
    ...assets.filter((a) => !savingAssetsPaths.includes(a.path)),
    ...savingAssets,
  ]);

  allEntries.update((entries) => [
    ...entries.filter((e) => !savingEntryIds.includes(e.id)),
    ...savingEntries,
  ]);

  const __focusedAsset = movingAssets.find((a) => a.asset.path === get(focusedAsset)?.path);
  const __overlaidAsset = movingAssets.find((a) => a.asset.path === get(overlaidAsset)?.path);

  // Replace the existing asset
  if (__focusedAsset) {
    focusedAsset.set(get(allAssets).find((a) => a.path === __focusedAsset.path));
  }

  // Replace the existing asset
  if (__overlaidAsset) {
    overlaidAsset.set(get(allAssets).find((a) => a.path === __overlaidAsset.path));
  }

  assetUpdatesToast.set({
    count: movingAssets.length,
    moved: action === 'move',
    renamed: action === 'rename',
  });
};

/**
 * Delete the given assets.
 * @param {Asset[]} assets - List of assets to be deleted.
 * @todo Update entries to remove these asset paths. If an asset is used for a required field, show
 * an error message and abort the operation.
 */
export const deleteAssets = async (assets) => {
  await get(backend)?.commitChanges(
    assets.map(({ path }) => ({ action: 'delete', path })),
    { commitType: 'deleteMedia' },
  );

  allAssets.update((_allAssets) => _allAssets.filter((asset) => !assets.includes(asset)));
  assetUpdatesToast.set({ deleted: true, count: assets.length });
};

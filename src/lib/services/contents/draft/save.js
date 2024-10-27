/* eslint-disable no-await-in-loop */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-continue */

import { generateUUID, getHash } from '@sveltia/utils/crypto';
import { toRaw } from '@sveltia/utils/object';
import { compare, escapeRegExp } from '@sveltia/utils/string';
import { unflatten } from 'flat';
import { TomlDate } from 'smol-toml';
import { get } from 'svelte/store';
import { hasRootListField } from '$lib/components/contents/details/widgets/list/helper';
import { allAssetFolders, allAssets, getAssetKind, getAssetsByDirName } from '$lib/services/assets';
import { backend, backendName, isLastCommitPublished } from '$lib/services/backends';
import { siteConfig } from '$lib/services/config';
import { allEntries } from '$lib/services/contents';
import { contentUpdatesToast } from '$lib/services/contents/data';
import { entryDraft } from '$lib/services/contents/draft';
import { deleteBackup } from '$lib/services/contents/draft/backup';
import { expandInvalidFields } from '$lib/services/contents/draft/editor';
import { validateEntry } from '$lib/services/contents/draft/validate';
import { getFieldConfig } from '$lib/services/contents/entry';
import { formatEntryFile, getFileExtension } from '$lib/services/contents/parser';
import { fillSlugTemplate } from '$lib/services/contents/slug';
import { user } from '$lib/services/user';
import { fullDateTimeRegEx } from '$lib/services/utils/date';
import { createPath, renameIfNeeded, resolvePath } from '$lib/services/utils/file';

/**
 * Get the internal/public asset path configuration for the entry assets.
 * @param {any} fillSlugOptions - Options to be passed to {@link fillSlugTemplate}.
 * @returns {{ internalBaseAssetFolder: string, internalAssetFolder: string, publicAssetFolder:
 * string }} Determined paths. `internalBaseAssetFolder` is the collection-defined path, while
 * `internalAssetFolder` may contain a sub path when the asset is entry-relative.
 */
export const getEntryAssetFolderPaths = (fillSlugOptions) => {
  const {
    collection: {
      path: entryPath,
      _i18n: { structure },
      _assetFolder,
    },
  } = fillSlugOptions;

  const subPath = entryPath?.match(/(.+?)(?:\/[^/]+)?$/)?.[1] ?? '';
  const isMultiFolders = structure === 'multiple_folders';
  const { entryRelative, internalPath, publicPath } = _assetFolder ?? get(allAssetFolders)[0];

  if (!entryRelative) {
    return {
      internalBaseAssetFolder: internalPath,
      internalAssetFolder: fillSlugTemplate(internalPath, fillSlugOptions),
      publicAssetFolder: fillSlugTemplate(publicPath, fillSlugOptions),
    };
  }

  return {
    internalBaseAssetFolder: internalPath,
    internalAssetFolder: resolvePath(
      fillSlugTemplate(
        createPath([
          internalPath,
          isMultiFolders || entryPath?.includes('/') ? subPath : undefined,
        ]),
        fillSlugOptions,
      ),
    ),
    publicAssetFolder:
      !isMultiFolders && publicPath.match(/^\.?$/)
        ? // Dot-only public path is a special case; the final path stored as the field value will
          // be `./image.png` rather than `image.png`
          publicPath
        : resolvePath(
            fillSlugTemplate(
              isMultiFolders
                ? // When multiple folders are used for i18n, the file structure would look like
                  // `{collection}/{locale}/{slug}.md` or `{collection}/{locale}/{slug}/index.md`
                  // and the asset path would be `{collection}/{slug}/{file}.jpg`
                  createPath([
                    ...Array((entryPath?.match(/\//g) ?? []).length + 1).fill('..'),
                    publicPath,
                    subPath,
                  ])
                : publicPath,
              fillSlugOptions,
            ),
          ),
  };
};

/**
 * Determine the file path for the given entry draft depending on the collection type, i18n config
 * and folder collections path.
 * @param {EntryDraft} draft - Entry draft.
 * @param {LocaleCode} locale - Locale code.
 * @param {string} slug - Entry slug.
 * @returns {string} Complete path, including the folder, slug, extension and possibly locale.
 * @see https://decapcms.org/docs/i18n/
 */
const createEntryPath = (draft, locale, slug) => {
  const { collection, collectionFile, originalEntry, currentValues } = draft;

  if (collectionFile) {
    const path = collectionFile.file;

    return path.includes('{{locale}}') ? path.replace('{{locale}}', locale) : path;
  }

  if (originalEntry?.locales[locale]) {
    return originalEntry.locales[locale].path;
  }

  const { defaultLocale, structure } = collection._i18n;
  const collectionFolder = collection.folder;

  /**
   * Support folder collections path.
   * @see https://decapcms.org/docs/collection-folder/#folder-collections-path
   */
  const path = collection.path
    ? fillSlugTemplate(collection.path, {
        collection,
        locale,
        content: currentValues[defaultLocale],
        currentSlug: slug,
      })
    : slug;

  const extension = getFileExtension({
    format: collection.format,
    extension: collection.extension,
  });

  const defaultOption = `${collectionFolder}/${path}.${extension}`;

  const pathOptions = {
    multiple_folders: `${collectionFolder}/${locale}/${path}.${extension}`,
    multiple_files: `${collectionFolder}/${path}.${locale}.${extension}`,
    single_file: defaultOption,
  };

  return pathOptions[structure] || pathOptions.single_file;
};

/**
 * Create a list of field names (flattened key path list) from the configured collection fields.
 * @param {Field[]} fields - Field list of a collection or a file.
 * @returns {FieldKeyPath[]} Sorted key path list. List items are keyed with `*`.
 * @example [`author.name`, `books.*.title`, `books.*.summary`, `publishDate`, `body`]
 */
const createKeyPathList = (fields) => {
  /** @type {FieldKeyPath[]} */
  const list = [];

  /**
   * Parse a field to generate a sorted key path list.
   * @param {Field} field - Single field.
   * @param {FieldKeyPath} keyPath - Key path of the field.
   */
  const parseField = (field, keyPath) => {
    const { widget } = field;
    const isList = widget === 'list';

    list.push(keyPath);

    if (isList || widget === 'object') {
      const {
        fields: subFields,
        types,
        typeKey = 'type',
      } = /** @type {ListField | ObjectField} */ (field);

      if (subFields) {
        subFields.forEach((subField) => {
          parseField(
            subField,
            isList ? `${keyPath}.*.${subField.name}` : `${keyPath}.${subField.name}`,
          );
        });
      } else if (types) {
        list.push(isList ? `${keyPath}.*.${typeKey}` : `${keyPath}.${typeKey}`);

        types.forEach((type) => {
          type.fields.forEach((subField) => {
            parseField(
              subField,
              isList ? `${keyPath}.*.${subField.name}` : `${keyPath}.${subField.name}`,
            );
          });
        });
      } else if (isList) {
        const { field: subField } = /** @type {ListField} */ (field);

        if (subField) {
          parseField(subField, `${keyPath}.*`);
        } else {
          list.push(`${keyPath}.*`);
        }
      }
    }

    if (widget === 'select' || widget === 'relation') {
      const { multiple = false } = /** @type {SelectField | RelationField} */ (field);

      list.push(multiple ? `${keyPath}.*` : keyPath);
    }
  };

  // Iterate over the top-level fields first
  fields.forEach((field) => {
    parseField(field, field.name);
  });

  return list;
};

/**
 * Sort the entry draft content’s object properties by the order of the configured collection
 * fields. The result can be formatted as expected with `JSON.stringify()`, as the built-in method
 * uses insertion order for string key ordering.
 * @param {Field[]} fields - Field list of a collection or a file.
 * @param {FlattenedEntryContent} valueMap - Flattened entry content.
 * @param {string} [canonicalSlugKey] - Property name of a canonical slug.
 * @returns {FlattenedEntryContent} Flattened entry content sorted by fields.
 */
const sortContentProps = (fields, valueMap, canonicalSlugKey) => {
  /** @type {FlattenedEntryContent} */
  const unsortedMap = toRaw(valueMap);
  /** @type {FlattenedEntryContent} */
  const sortedMap = {};

  /**
   * Move a property name/value from {@link unsortedMap} to {@link sortedMap}.
   * @param {string} key - Property name.
   */
  const copyProperty = (key) => {
    sortedMap[key] = unsortedMap[key];
    delete unsortedMap[key];
  };

  // Add the slug first
  if (canonicalSlugKey && canonicalSlugKey in unsortedMap) {
    copyProperty(canonicalSlugKey);
  }

  // Move the listed properties to a new object
  createKeyPathList(fields).forEach((keyPath) => {
    if (keyPath in unsortedMap) {
      copyProperty(keyPath);
    } else {
      const regex = new RegExp(
        `^${escapeRegExp(keyPath.replaceAll('*', '\\d+')).replaceAll('\\\\d\\+', '\\d+')}$`,
      );

      Object.keys(unsortedMap)
        .filter((_keyPath) => _keyPath.match(regex))
        .sort(([a, b]) => compare(a, b))
        .forEach(copyProperty);
    }
  });

  // Move the remainder, if any, to a new object
  Object.keys(unsortedMap)
    .sort(([a, b]) => compare(a, b))
    .forEach(copyProperty);

  return sortedMap;
};

/**
 * Modify the content for TOML output, particularly date/time.
 * @param {object} args - Arguments.
 * @param {string} args.collectionName - Collection name.
 * @param {string} [args.fileName] - File name.
 * @param {FlattenedEntryContent} args.valueMap - Object holding current entry values.
 * @returns {FlattenedEntryContent} Modified content.
 * @see https://github.com/squirrelchat/smol-toml?tab=readme-ov-file#dates
 * @see https://toml.io/en/v1.0.0#offset-date-time
 */
const modifyContentForTOML = ({ collectionName, fileName, valueMap }) => {
  Object.entries(valueMap).forEach(([keyPath, value]) => {
    if (
      typeof value === 'string' &&
      value.match(fullDateTimeRegEx) &&
      getFieldConfig({ collectionName, fileName, valueMap, keyPath })?.widget === 'datetime'
    ) {
      try {
        valueMap[keyPath] = new TomlDate(value);
      } catch {
        //
      }
    }
  });

  return valueMap;
};

/**
 * Create saving entry data.
 * @param {object} args - Arguments.
 * @param {boolean} args.isNew - `true` if it’s a new folder collection entry draft.
 * @param {Collection} args.collection - Collection details.
 * @param {Entry} [args.originalEntry] - Original entry if the entry draft is not new.
 * @param {CollectionFile} [args.collectionFile] - File details. File collection only.
 * @param {string} args.defaultLocaleSlug - Default locale’s entry slug.
 * @param {LocaleStateMap} args.originalLocales - Locale state map when the draft is created.
 * @param {LocaleStateMap} args.currentLocales - Current locale state.
 * @param {LocalizedEntryMap} args.localizedEntryMap - Localized entry map.
 * @returns {Promise<{ savingEntry: Entry, changes: FileChange[] }>} Saving entry and file changes.
 */
export const createSavingEntryData = async ({
  isNew,
  collection,
  collectionFile,
  originalEntry,
  defaultLocaleSlug,
  originalLocales,
  currentLocales,
  localizedEntryMap,
}) => {
  const { name: collectionName, _parserConfig } = collection;
  const fileName = collectionFile?.name;
  const { extension, format } = _parserConfig;
  const isTomlOutput = extension === 'toml' || format === 'toml' || format === 'toml-frontmatter';

  const {
    fields = [],
    _i18n: {
      i18nEnabled,
      locales,
      defaultLocale,
      structure,
      canonicalSlug: { key: canonicalSlugKey },
    },
  } = collectionFile ?? collection;

  const _hasRootListField = hasRootListField(fields);

  /**
   * @type {Entry}
   */
  const savingEntry = {
    id: originalEntry?.id ?? generateUUID(),
    slug: defaultLocaleSlug,
    sha: '', // Populated later
    locales: Object.fromEntries(
      Object.entries(localizedEntryMap).filter(([, { content }]) => !!content),
    ),
  };

  /**
   * @type {FileChange[]}
   */
  const changes = [];

  /**
   * Finalize the content by modifying for a specific data format and unflattening the object.
   * @param {FlattenedEntryContent} valueMap - Original content.
   * @returns {RawEntryContent} Modified and unflattened content.
   */
  const finalizeContent = (valueMap) => {
    let content = sortContentProps(fields, valueMap, canonicalSlugKey);

    if (isTomlOutput) {
      content = modifyContentForTOML({ collectionName, fileName, valueMap: content });
    }

    content = unflatten(content);

    // Handle a special case: top-level list field
    if (_hasRootListField) {
      content = content[fields[0].name] ?? [];
    }

    return content;
  };

  if (!i18nEnabled || structure === 'single_file') {
    const localizedEntry = savingEntry.locales[defaultLocale];
    const { slug, path, content } = localizedEntry;
    const action = isNew ? 'create' : 'update';

    const data = formatEntryFile({
      content: i18nEnabled
        ? Object.fromEntries(
            Object.entries(savingEntry.locales).map(([locale, le]) => [
              locale,
              finalizeContent(le.content),
            ]),
          )
        : finalizeContent(content),
      path,
      config: _parserConfig,
    });

    changes.push({ action, slug, path, data });
    localizedEntry.sha = await getHash(new Blob([data], { type: 'text/plain' }));
  } else {
    await Promise.all(
      locales.map(async (locale) => {
        const localizedEntry = savingEntry.locales[locale];
        const { slug, path, content } = localizedEntry ?? {};

        if (currentLocales[locale]) {
          const action = isNew || !originalLocales[locale] ? 'create' : 'update';

          const data = formatEntryFile({
            content: finalizeContent(content),
            path,
            config: _parserConfig,
          });

          changes.push({ action, slug, path, data });
          localizedEntry.sha = await getHash(new Blob([data], { type: 'text/plain' }));
        } else if (originalLocales[locale]) {
          changes.push({ action: 'delete', slug, path });
        }

        return true;
      }),
    );
  }

  savingEntry.sha = savingEntry.locales[defaultLocale].sha;

  return { savingEntry, changes };
};

/**
 * Save the entry draft.
 * @param {object} [options] - Options.
 * @param {boolean} [options.skipCI] - Whether to disable automatic deployments for the change.
 * @returns {Promise<Entry>} Saved entry.
 * @throws {Error} When the entry could not be validated or saved.
 */
export const saveEntry = async ({ skipCI = undefined } = {}) => {
  const draft = /** @type {EntryDraft} */ (get(entryDraft));

  const {
    collection,
    isNew,
    originalLocales,
    currentLocales,
    originalEntry,
    collectionName,
    collectionFile,
    fileName,
    currentValues,
    files,
  } = draft;

  if (!validateEntry()) {
    expandInvalidFields({ collectionName, fileName, currentValues });

    throw new Error('validation_failed');
  }

  const _user = /** @type {User} */ (get(user));

  const {
    identifier_field: identifierField = 'title',
    slug: slugTemplate = `{{${identifierField}}}`,
  } = collection;

  const {
    _i18n: {
      defaultLocale,
      structure,
      canonicalSlug: { key: canonicalSlugKey, value: canonicalSlugTemplate },
    },
  } = collectionFile ?? collection;

  const fillSlugOptions = { collection, content: currentValues[defaultLocale] };

  /**
   * The slug of the default locale.
   */
  const defaultLocaleSlug =
    fileName ?? originalEntry?.slug ?? fillSlugTemplate(slugTemplate, fillSlugOptions);

  /**
   * List of key paths that the value will be localized.
   */
  const localizingKeyPaths = [...slugTemplate.matchAll(/{{(?:fields\.)?(.+?)( \| localize)?}}/g)]
    .filter(([, , localize]) => !!localize)
    .map(([, keyPath]) => keyPath);

  /**
   * Localized slug map. This only applies when the i18n structure is multiple files or folders, and
   * the slug template contains the `localize` flag, e.g. `{{title | localize}}`.
   */
  const localizedSlugs =
    structure === 'single_file' || !localizingKeyPaths.length
      ? undefined
      : Object.fromEntries(
          Object.entries(currentLocales)
            .filter(([, enabled]) => enabled)
            .map(([locale]) => [
              locale,
              locale === defaultLocale
                ? defaultLocaleSlug
                : fillSlugTemplate(slugTemplate, {
                    collection,
                    locale,
                    content: {
                      // Merge the default locale content and localized content
                      ...currentValues[defaultLocale],
                      ...Object.fromEntries(
                        localizingKeyPaths.map((keyPath) => [
                          keyPath,
                          currentValues[locale][keyPath],
                        ]),
                      ),
                    },
                  }),
            ]),
        );

  /**
   * A canonical slug to be added to the content of each file when the slug is localized. It helps
   * Sveltia CMS and some frameworks to link localized files. The default property name is
   * `translationKey` used in Hugo’s multilingual support, and the default value is the default
   * locale’s slug.
   * @see https://github.com/sveltia/sveltia-cms#localizing-entry-slugs
   * @see https://gohugo.io/content-management/multilingual/#bypassing-default-linking
   */
  // eslint-disable-next-line no-nested-ternary
  const canonicalSlug = !localizedSlugs
    ? undefined
    : canonicalSlugTemplate === '{{slug}}'
      ? defaultLocaleSlug
      : fillSlugTemplate(canonicalSlugTemplate, {
          ...fillSlugOptions,
          currentSlug: defaultLocaleSlug,
        });

  const { internalBaseAssetFolder, internalAssetFolder, publicAssetFolder } =
    getEntryAssetFolderPaths({
      ...fillSlugOptions,
      type: 'media_folder',
      currentSlug: defaultLocaleSlug,
      entryFilePath: createEntryPath(draft, defaultLocale, defaultLocaleSlug),
    });

  const assetNamesInSameFolder = getAssetsByDirName(internalAssetFolder).map((a) =>
    a.name.normalize(),
  );

  /**
   * @type {FileChange[]}
   */
  const changes = [];
  /**
   * @type {Asset[]}
   */
  const savingAssets = [];

  const savingAssetProps = {
    /** @type {string | undefined} */
    text: undefined,
    collectionName,
    folder: internalBaseAssetFolder,
    commitAuthor: _user.email
      ? /** @type {CommitAuthor} */ ({ name: _user.name, email: _user.email })
      : undefined,
    commitDate: new Date(), // Use the current datetime
  };

  /**
   * @type {LocalizedEntryMap}
   */
  const localizedEntryMap = Object.fromEntries(
    await Promise.all(
      Object.entries(currentValues).map(async ([locale, content]) => {
        const localizedSlug = localizedSlugs?.[locale];
        const slug = localizedSlug ?? defaultLocaleSlug;
        const path = createEntryPath(draft, locale, slug);

        if (!currentLocales[locale]) {
          return [locale, { path }];
        }

        // Add the canonical slug if it doesn’t exist in the content
        if (!content[canonicalSlugKey] && canonicalSlug) {
          content[canonicalSlugKey] = canonicalSlug;
        }

        // Normalize data
        for (const [keyPath, value] of Object.entries(content)) {
          if (value === undefined) {
            delete content[keyPath];
            continue;
          }

          if (typeof value !== 'string') {
            continue;
          }

          // Remove leading & trailing whitespace
          content[keyPath] = value.trim();

          // Replace a blob URL with the final path, and add the file to the changeset
          if (value.startsWith('blob:')) {
            const file = files[locale][keyPath];
            const sha = await getHash(file);
            const dupFile = savingAssets.find((f) => f.sha === sha);

            // Check if the file has already been added for other field or locale
            if (dupFile) {
              content[keyPath] = publicAssetFolder
                ? `${publicAssetFolder}/${dupFile.name}`
                : dupFile.name;

              continue;
            }

            const assetName = renameIfNeeded(file.name.normalize(), assetNamesInSameFolder);
            const assetPath = `${internalAssetFolder}/${assetName}`;

            assetNamesInSameFolder.push(assetName);
            changes.push({ action: 'create', path: assetPath, data: file });

            savingAssets.push({
              ...savingAssetProps,
              blobURL: URL.createObjectURL(file),
              name: assetName,
              path: assetPath,
              sha,
              size: file.size,
              kind: getAssetKind(assetName),
            });

            content[keyPath] = publicAssetFolder ? `${publicAssetFolder}/${assetName}` : assetName;
          }
        }

        return [locale, { slug, path, sha: '', content: toRaw(content) }];
      }),
    ),
  );

  const { savingEntry, changes: savingEntryChanges } = await createSavingEntryData({
    isNew,
    collection,
    collectionFile,
    originalEntry,
    defaultLocaleSlug,
    localizedEntryMap,
    currentLocales,
    originalLocales,
  });

  changes.push(...savingEntryChanges);

  try {
    await /** @type {BackendService} */ (get(backend)).commitChanges(changes, {
      commitType: isNew ? 'create' : 'update',
      collection,
      skipCI,
    });
  } catch (/** @type {any} */ ex) {
    // eslint-disable-next-line no-console
    console.error(ex);

    throw new Error('saving_failed', { cause: ex });
  }

  const savingAssetsPaths = savingAssets.map((a) => a.path);

  allEntries.update((entries) => [...entries.filter((e) => e.id !== savingEntry.id), savingEntry]);

  allAssets.update((assets) => [
    ...assets.filter((a) => !savingAssetsPaths.includes(a.path)),
    ...savingAssets,
  ]);

  const isLocal = get(backendName) === 'local';

  const { backend: { automatic_deployments: autoDeployEnabled = undefined } = {} } =
    get(siteConfig) ?? /** @type {SiteConfig} */ ({});

  const published =
    !isLocal && (skipCI === undefined ? autoDeployEnabled === true : skipCI === false);

  contentUpdatesToast.set({
    saved: true,
    published,
    deleted: false,
    count: 1,
  });

  isLastCommitPublished.set(published);

  deleteBackup(collectionName, isNew ? '' : defaultLocaleSlug);

  return savingEntry;
};

import { mustBeDefined } from 'common-utils/util.js';
import { CSpellUserSettings, searchForConfig } from 'cspell-lib';
import * as Path from 'path';
import { URI } from 'vscode-uri';

import { WorkspaceConfigForDocument } from '../api';
import { ConfigTargetCSpell, ConfigTargetDictionary, ConfigTargetVSCode } from './configTargets';
import { __testing__, calculateConfigTargets } from './configTargetsHelper';
import { DictionaryDef } from './cspellConfig/CustomDictionary';
import { extractCSpellFileConfigurations, extractTargetDictionaries } from './documentSettings';

const { workspaceConfigToTargets, cspellToTargets, dictionariesToTargets, sortTargets } = __testing__;

const col = new Intl.Collator();

describe('Validate configTargetsHelper', () => {
    test('workspaceConfigToTargets in single root workspace', () => {
        const wConfig: WorkspaceConfigForDocument = {
            uri: URI.file(__filename).toString(),
            workspaceFile: undefined,
            workspaceFolder: URI.file(__dirname).toString(),
            words: {
                user: true,
            },
            ignoreWords: {},
        };
        const r = [...workspaceConfigToTargets(wConfig)];
        expect(r).toEqual([
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'user',
                name: 'User',
                docUri: expect.stringContaining('file:'),
                has: { words: true, ignoreWords: undefined },
            }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'workspace',
                name: 'Workspace',
                docUri: expect.stringContaining('file:'),
                has: { words: undefined, ignoreWords: undefined },
            }),
        ]);
    });

    test('workspaceConfigToTargets in multi root workspace', () => {
        const wConfig: WorkspaceConfigForDocument = {
            uri: URI.file(__filename).toString(),
            workspaceFile: 'file://workspace-file.code-workspace',
            workspaceFolder: URI.file(__dirname).toString(),
            words: {
                user: true,
                folder: true,
            },
            ignoreWords: {
                folder: true,
            },
        };
        const r = [...workspaceConfigToTargets(wConfig)];
        expect(r).toEqual([
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'user',
                name: 'User',
                docUri: wConfig.uri,
                has: { words: true, ignoreWords: undefined },
            }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'workspace',
                name: 'Workspace',
                docUri: wConfig.uri,
                has: { words: undefined, ignoreWords: undefined },
            }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'folder',
                name: 'Folder',
                docUri: wConfig.uri,
                has: { words: true, ignoreWords: true },
            }),
        ]);
    });

    test('workspaceConfigToTargets with no workspace', () => {
        const wConfig: WorkspaceConfigForDocument = {
            uri: URI.file(__filename).toString(),
            workspaceFile: undefined,
            workspaceFolder: undefined,
            words: {
                user: true,
            },
            ignoreWords: {},
        };
        const r = [...workspaceConfigToTargets(wConfig)];
        expect(r).toEqual([
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'user',
                name: 'User',
                docUri: wConfig.uri,
                has: { words: true, ignoreWords: undefined },
            }),
        ]);
    });

    test('cspellToTargets', async () => {
        const cfg = mustBeDefined(await searchForConfig(__dirname));
        const sources = extractCSpellFileConfigurations(cfg);
        const r = cspellToTargets(sources);
        expect(r).toEqual([
            oc<ConfigTargetCSpell>({
                kind: 'cspell',
                name: '_server/cspell.json',
                scope: 'unknown',
                configUri: expect.stringContaining('_server/cspell.json'),
                has: { words: undefined, ignoreWords: undefined },
            }),
            oc<ConfigTargetCSpell>({
                kind: 'cspell',
                name: expect.stringContaining('cspell.json'),
                scope: 'unknown',
                configUri: expect.not.stringContaining('_server/cspell.json'),
                has: { words: undefined, ignoreWords: true },
            }),
        ]);
    });

    test('dictionariesToTargets', async () => {
        const cfg = mustBeDefined(await searchForConfig(__dirname));
        const dictionaries = extractTargetDictionaries(cfg).concat([
            {
                name: 'local-words',
                path: Path.join(__dirname, 'local-words.txt'),
                addWords: true,
            },
            {
                name: 'user-words',
                path: Path.join(__dirname, 'user-words.txt'),
                addWords: true,
                scope: 'user',
            },
        ]);
        const r = sortTargets(dictionariesToTargets(dictionaries));
        expect(r).toEqual([
            oc<ConfigTargetDictionary>({
                kind: 'dictionary',
                name: 'local-words',
                scope: 'unknown',
                dictionaryUri: expect.stringContaining('local-words.txt'),
            }),
            oc<ConfigTargetDictionary>({
                kind: 'dictionary',
                name: 'cspell-words',
                scope: 'workspace',
                dictionaryUri: expect.stringContaining('cspell-words.txt'),
            }),
            oc<ConfigTargetDictionary>({
                kind: 'dictionary',
                name: 'user-words',
                scope: 'user',
                dictionaryUri: expect.stringContaining('user-words.txt'),
            }),
        ]);
    });

    test('calculateConfigTargets user', async () => {
        const wConfig: WorkspaceConfigForDocument = {
            uri: URI.file(__filename).toString(),
            workspaceFile: undefined,
            workspaceFolder: URI.file(__dirname).toString(),
            words: {
                user: true,
            },
            ignoreWords: {},
        };
        const cfg = mustBeDefined(await searchForConfig(__dirname));
        const settings = { ...cfg };
        const r = calculateConfigTargets(settings, wConfig);
        expect(r).toEqual([
            oc<ConfigTargetDictionary>({
                kind: 'dictionary',
                name: 'cspell-words',
                scope: 'workspace',
                dictionaryUri: expect.stringContaining('cspell-words.txt'),
            }),
            oc<ConfigTargetCSpell>({
                kind: 'cspell',
                name: '_server/cspell.json',
                scope: 'unknown',
                configUri: expect.stringContaining('_server/cspell.json'),
                has: { words: undefined, ignoreWords: undefined },
            }),
            oc<ConfigTargetCSpell>({
                kind: 'cspell',
                name: expect.stringContaining('cspell.json'),
                scope: 'unknown',
                configUri: expect.not.stringContaining('_server/cspell.json'),
                has: { words: undefined, ignoreWords: true },
            }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'workspace',
                name: 'Workspace',
                docUri: expect.stringContaining('file:'),
                has: { words: undefined, ignoreWords: undefined },
            }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'user',
                name: 'User',
                docUri: expect.stringContaining('file:'),
                has: { words: true, ignoreWords: undefined },
            }),
        ]);
    });

    test('calculateConfigTargets workspace', async () => {
        const wConfig: WorkspaceConfigForDocument = {
            uri: URI.file(__filename).toString(),
            workspaceFile: undefined,
            workspaceFolder: URI.file(__dirname).toString(),
            words: {
                workspace: true,
            },
            ignoreWords: {},
        };
        const cfg = mustBeDefined(await searchForConfig(__dirname));
        const defs: DictionaryDef[] = [cd('custom-words', 'path/to/custom-words.txt', false)];
        const dictionaries: string[] = (cfg.dictionaries || []).concat('custom-words');
        const settings: CSpellUserSettings = { ...cfg, dictionaryDefinitions: defs, dictionaries };
        const r = calculateConfigTargets(settings, wConfig).sort((a, b) => col.compare(a.kind, b.kind) || col.compare(a.name, b.name));
        expect(r).toEqual([
            oc<ConfigTargetCSpell>({
                kind: 'cspell',
                name: '_server/cspell.json',
                scope: 'unknown',
                configUri: expect.stringContaining('_server/cspell.json'),
                has: { words: undefined, ignoreWords: undefined },
            }),
            oc<ConfigTargetCSpell>({
                kind: 'cspell',
                name: expect.stringContaining('cspell.json'),
                scope: 'unknown',
                configUri: expect.not.stringContaining('_server/cspell.json'),
                has: { words: undefined, ignoreWords: true },
            }),
            // oc<ConfigTargetDictionary>({
            //     kind: 'dictionary',
            //     name: 'custom-words',
            //     scope: 'unknown',
            //     dictionaryUri: expect.stringContaining('custom-words.txt'),
            // }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'user',
                name: 'User',
                docUri: expect.stringContaining('file:'),
                has: { words: undefined, ignoreWords: undefined },
            }),
            oc<ConfigTargetVSCode>({
                kind: 'vscode',
                scope: 'workspace',
                name: 'Workspace',
                docUri: expect.stringContaining('file:'),
                has: { words: true, ignoreWords: undefined },
            }),
        ]);
    });
});

function cd(name: string, path: string, addWords?: boolean, noSuggest?: boolean): DictionaryDef {
    return {
        name,
        path,
        addWords,
        noSuggest,
    };
}

function oc<T>(v: Partial<T>): T {
    return expect.objectContaining(v);
}

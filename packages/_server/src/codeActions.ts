import { log, logDebug } from 'common-utils/log.js';
import { capitalize } from 'common-utils/util.js';
import { constructSettingsForText, getDictionary, IssueType, SpellingDictionary, Text } from 'cspell-lib';
import { format } from 'util';
import { CodeActionParams, Command as LangServerCommand, Range as LangServerRange, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
// eslint-disable-next-line node/no-extraneous-import
import { CodeAction, CodeActionKind, Diagnostic, TextEdit } from 'vscode-languageserver-types';

import { ClientApi } from './clientApi';
import { clientCommands as cc } from './commands';
import {
    ConfigKinds,
    ConfigScope,
    ConfigScopes,
    ConfigTarget,
    ConfigTargetCSpell,
    ConfigTargetDictionary,
    ConfigTargetVSCode,
} from './config/configTargets';
import { calculateConfigTargets } from './config/configTargetsHelper';
import { CSpellUserSettings } from './config/cspellConfig';
import { isUriAllowed } from './config/documentSettings';
import { DiagnosticData } from './models/DiagnosticData';
import { Suggestion } from './models/Suggestion';
import { GetSettingsResult, SuggestionGenerator } from './SuggestionsGenerator';
import { uniqueFilter } from './utils';
import * as range from './utils/range';
import * as Validator from './validator';

const createCommand = LangServerCommand.create;

function extractText(textDocument: TextDocument, range: LangServerRange) {
    return textDocument.getText(range);
}

const debugTargets = false;

function extractDiagnosticData(diag: Diagnostic): DiagnosticData {
    const { data } = diag;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data as DiagnosticData;
}

export function onCodeActionHandler(
    documents: TextDocuments<TextDocument>,
    fnSettings: (doc: TextDocument) => Promise<CSpellUserSettings>,
    fnSettingsVersion: (doc: TextDocument) => number,
    clientApi: ClientApi
): (params: CodeActionParams) => Promise<CodeAction[]> {
    const codeActionHandler = new CodeActionHandler(documents, fnSettings, fnSettingsVersion, clientApi);

    return (params) => codeActionHandler.handler(params);
}

type SettingsDictPair = GetSettingsResult;
interface CacheEntry {
    docVersion: number;
    settingsVersion: number;
    settings: Promise<SettingsDictPair>;
}

class CodeActionHandler {
    private sugGen: SuggestionGenerator<TextDocument>;
    private settingsCache: Map<string, CacheEntry>;

    constructor(
        readonly documents: TextDocuments<TextDocument>,
        readonly fnSettings: (doc: TextDocument) => Promise<CSpellUserSettings>,
        readonly fnSettingsVersion: (doc: TextDocument) => number,
        readonly clientApi: ClientApi
    ) {
        this.settingsCache = new Map<string, CacheEntry>();
        this.sugGen = new SuggestionGenerator((doc) => this.getSettings(doc));
    }

    async getSettings(doc: TextDocument): Promise<GetSettingsResult> {
        const cached = this.settingsCache.get(doc.uri);
        const settingsVersion = this.fnSettingsVersion(doc);
        if (!cached || cached.docVersion !== doc.version || cached.settingsVersion !== settingsVersion) {
            const settings = this.constructSettings(doc);
            this.settingsCache.set(doc.uri, { docVersion: doc.version, settings, settingsVersion });
        }
        return this.settingsCache.get(doc.uri)!.settings;
    }

    private async constructSettings(doc: TextDocument): Promise<SettingsDictPair> {
        const settings = constructSettingsForText(await this.fnSettings(doc), doc.getText(), doc.languageId);
        const dictionary = await getDictionary(settings);
        return { settings, dictionary };
    }

    public async handler(params: CodeActionParams): Promise<CodeAction[]> {
        const {
            context,
            textDocument: { uri },
        } = params;
        const { diagnostics } = context;
        const spellCheckerDiags = diagnostics.filter((diag) => diag.source === Validator.diagSource);
        const eslintSpellCheckerDiags = diagnostics.filter((diag) => diag.source === 'eslint' && diag.code == '@cspell/spellchecker');

        if (!spellCheckerDiags.length && !eslintSpellCheckerDiags.length) return [];

        const textDocument = this.documents.get(uri);
        if (!textDocument) return [];

        const rangeIntersectDiags = [...spellCheckerDiags, ...eslintSpellCheckerDiags]
            .map((diag) => diag.range)
            .reduce((a: LangServerRange | undefined, b) => a && range.intersect(a, b), params.range);

        // Only provide suggestions if the selection is contained in the diagnostics.
        if (!rangeIntersectDiags || !(range.equal(params.range, rangeIntersectDiags) || isWordLikeSelection(textDocument, params.range))) {
            return [];
        }

        const ctx = {
            params,
            textDocument,
        };

        return eslintSpellCheckerDiags.length
            ? this.handlerESLint({ ...ctx, diags: eslintSpellCheckerDiags })
            : this.handlerCSpell({ ...ctx, diags: spellCheckerDiags });
    }

    private async handlerCSpell(handlerContext: CodeActionHandlerContext) {
        const { params, textDocument, diags: spellCheckerDiags } = handlerContext;
        const actions: CodeAction[] = [];
        const uri = textDocument.uri;
        if (!spellCheckerDiags.length) return [];

        // We do not want to clutter the actions when someone is trying to refactor code
        if (spellCheckerDiags.length > 1) return [];

        const { settings: docSetting, dictionary } = await this.getSettings(textDocument);
        if (!isUriAllowed(uri, docSetting.allowedSchemas)) {
            log(`CodeAction Uri Not allowed: ${uri}`);
            return [];
        }
        const pWorkspaceConfig = this.clientApi.sendOnWorkspaceConfigForDocumentRequest({ uri });

        function replaceText(range: LangServerRange, text?: string) {
            return TextEdit.replace(range, text || '');
        }

        const getSuggestions = (word: string) => {
            return this.sugGen.genWordSuggestions(textDocument, word);
        };

        async function genCodeActionsForSuggestions(_dictionary: SpellingDictionary) {
            log('CodeAction generate suggestions');
            let isSpellingIssue: boolean | undefined;
            let diagWord: string | undefined;
            for (const diag of spellCheckerDiags) {
                const { issueType = IssueType.spelling, suggestions } = extractDiagnosticData(diag);
                isSpellingIssue = isSpellingIssue || issueType === IssueType.spelling;
                const srcWord = extractText(textDocument, diag.range);
                diagWord = diagWord || srcWord;
                const sugs: Suggestion[] = suggestions ?? (await getSuggestions(srcWord));
                sugs.map(({ word, isPreferred }) => ({ word: Text.isLowerCase(word) ? Text.matchCase(srcWord, word) : word, isPreferred }))
                    .filter(uniqueFilter())
                    .forEach((sug) => {
                        const sugWord = sug.word;
                        const title = suggestionToTitle(sug, issueType);
                        if (!title) return;
                        const cmd = createCommand(title, 'cSpell.editText', uri, textDocument.version, [replaceText(diag.range, sugWord)]);
                        const action = createAction(cmd, [diag], sug.isPreferred);
                        actions.push(action);
                    });
            }
            isSpellingIssue = isSpellingIssue ?? true;
            const word = diagWord || extractText(textDocument, params.range);
            // Only suggest adding if it is our diagnostic and there is a word.
            if (isSpellingIssue && word && spellCheckerDiags.length) {
                const wConfig = await pWorkspaceConfig;
                const targets = calculateConfigTargets(docSetting, wConfig);
                debugTargets && logTargets(targets);

                if (!docSetting.hideAddToDictionaryCodeActions) {
                    actions.push(...generateTargetActions(textDocument, spellCheckerDiags, word, targets));
                }
            }
            return actions;
        }

        return genCodeActionsForSuggestions(dictionary);
    }

    private async handlerESLint(handlerContext: CodeActionHandlerContext): Promise<CodeAction[]> {
        const { params, textDocument, diags: eslintSpellCheckerDiags } = handlerContext;
        const uri = textDocument.uri;
        const actions: CodeAction[] = [];
        if (!eslintSpellCheckerDiags.length) return [];

        // We do not want to clutter the actions when someone is trying to refactor code
        // or if it is already handled by ESLint.
        if (eslintSpellCheckerDiags.length > 1) return [];

        const { settings: docSetting, dictionary } = await this.getSettings(textDocument);
        const pWorkspaceConfig = this.clientApi.sendOnWorkspaceConfigForDocumentRequest({ uri });

        async function genCodeActions(_dictionary: SpellingDictionary) {
            const word = extractText(textDocument, params.range);
            // Only suggest adding if it is our diagnostic and there is a word.
            if (word && eslintSpellCheckerDiags.length) {
                const wConfig = await pWorkspaceConfig;
                const targets = calculateConfigTargets(docSetting, wConfig);
                debugTargets && logTargets(targets);

                if (!docSetting.hideAddToDictionaryCodeActions) {
                    actions.push(...generateTargetActions(textDocument, eslintSpellCheckerDiags, word, targets));
                }
            }
            return actions;
        }

        return genCodeActions(dictionary);
    }
}

interface CodeActionHandlerContext {
    params: CodeActionParams;
    diags: Diagnostic[];
    textDocument: TextDocument;
}

const directiveToTitle: Record<string, string | undefined> = Object.assign(Object.create(null), {
    dictionary: 'cspell\x3adictionary - Enable Dictionaries for the file.',
    dictionaries: 'cspell\x3adictionaries - Enable Dictionaries for the file.',
    disable: 'cspell\x3adisable - Disable Spell Checking from this point.',
    disableCaseSensitive: 'cspell\x3adisableCaseSensitive - Disable for the file.',
    'disable-line': 'cspell\x3adisable-line - Do not spell check this line.',
    'disable-next': 'cspell\x3adisable-next - Do not spell check the next line.',
    'disable-next-line': 'cspell\x3adisable-next-line - Do not spell check the next line.',
    enable: 'cspell\x3aenable - Enable Spell Checking from this point.',
    enableCaseSensitive: 'cspell\x3aenableCaseSensitive - Enable for the file.',
    ignore: 'cspell\x3aignore - Ignore [word].',
    locale: 'cspell\x3alocale - Set the locale.',
    word: 'cspell\x3aword - Allow word [word].',
    words: 'cspell\x3awords - Allow words [word].',
});

const directivesToHide: Record<string, true | undefined> = {
    local: true,
};

function suggestionToTitle(sug: Suggestion, issueType: IssueType): string | undefined {
    const sugWord = sug.word;
    if (issueType === IssueType.spelling) return sugWord + (sug.isPreferred ? ' (Auto Fix)' : '');
    if (sugWord in directivesToHide) return undefined;
    return directiveToTitle[sugWord] || 'cspell\x3a' + sugWord;
}

function logTargets(targets: ConfigTarget[]): void {
    logDebug(format('Config Targets %o', targets));
}

function createAction(cmd: LangServerCommand, diags: Diagnostic[] | undefined, isPreferred?: boolean): CodeAction {
    const action = CodeAction.create(cmd.title, cmd, CodeActionKind.QuickFix);
    action.diagnostics = diags;
    if (isPreferred) {
        action.isPreferred = true;
    }
    return action;
}

function calcScopeText(t: ConfigTarget) {
    return t.scope !== ConfigScopes.Unknown ? ` (${capitalize(t.scope)})` : '';
}

function generateTargetActions(doc: TextDocument, spellCheckerDiags: Diagnostic[], word: string, targets: ConfigTarget[]): CodeAction[] {
    const handled = new Set<ConfigScope>();

    const filtered = targets.filter((t) => {
        if (t.kind === 'dictionary' || !handled.has(t.scope) || t.has.words) {
            handled.add(t.scope);
            return true;
        }
        return false;
    });

    function dict(t: ConfigTargetDictionary): CodeAction {
        const name = t.name;
        const uri = t.dictionaryUri;
        const scopeText = calcScopeText(t);
        return createAction(
            cc.addWordsToDictionaryFileFromServer(`Add: "${word}" to dictionary: ${t.name}${scopeText}`, [word], doc.uri, {
                name,
                uri,
            }),
            spellCheckerDiags
        );
    }

    function cspell(t: ConfigTargetCSpell): CodeAction {
        return createAction(
            cc.addWordsToConfigFileFromServer(`Add: "${word}" to config: ${t.name}`, [word], doc.uri, {
                name: t.name,
                uri: t.configUri,
            }),
            spellCheckerDiags
        );
    }

    function vscode(t: ConfigTargetVSCode): CodeAction {
        return createAction(
            cc.addWordsToVSCodeSettingsFromServer(`Add: "${word}" to ${t.scope} settings`, [word], doc.uri, t.scope),
            spellCheckerDiags
        );
    }

    const actions: CodeAction[] = filtered.map((t) => {
        switch (t.kind) {
            case ConfigKinds.Vscode:
                return vscode(t);
            case ConfigKinds.Cspell:
                return cspell(t);
            case ConfigKinds.Dictionary:
                return dict(t);
        }
    });
    return actions;
}

function isWordLikeSelection(doc: TextDocument, range: LangServerRange): boolean {
    if (range.start.line !== range.end.line) return false;

    const text = doc.getText(range);
    const hasSpace = /\s/.test(text.trim());
    return !hasSpace;
}

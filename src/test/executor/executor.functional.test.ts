import * as assert from 'assert';
import * as path from 'path';
const sinon = require('sinon');
import { ConfigurationTarget, Uri, commands, extensions, workspace } from 'vscode';
import { ExecutorBridge, ExecutorManager, ProcessStatus, ProcessType } from '../../backend/executor';
import { CodeCheckerExtension } from '../../extension';
import { STATIC_WORKSPACE_PATH } from '../utils/constants';
import { closeAllTabs, openDocument } from '../utils/files';

suite('Functional Test: Backend - Executor', () => {
    let extensionMembers: CodeCheckerExtension;
    let executorManager: ExecutorManager;
    let executorBridge: ExecutorBridge;

    const filePath = path.join(STATIC_WORKSPACE_PATH, 'file.cpp');

    const processStatusChange = async () => new Promise<void>((res, rej) => {
        const disposable = executorManager.processStatusChange((status) => {
            switch (status) {
            case ProcessStatus.finished:
                disposable.dispose();
                res();
                return;
            case ProcessStatus.errored:
            case ProcessStatus.killed:
                disposable.dispose();
                rej('process not exited cleanly');
                return;
            }
        });
    });

    const updateOutputFolder = async(targetFolder?: string) => {
        await workspace.getConfiguration('codechecker.backend').update(
            'outputFolder',
            targetFolder,
            ConfigurationTarget.Workspace
        );
    };

    suiteSetup('Load extension', async function() {
        extensionMembers = await extensions.getExtension('codechecker.codechecker')!.activate();
        executorManager = extensionMembers.extensionApi.executorManager;
        executorBridge = extensionMembers.extensionApi.executorBridge;

        await workspace.fs.createDirectory(Uri.file(path.join(STATIC_WORKSPACE_PATH, '.codechecker-alt')));

        await updateOutputFolder('${workspaceFolder}/.codechecker-alt');
    });

    suiteTeardown('Cleanup generated files', async function() {
        await updateOutputFolder(undefined);
        await closeAllTabs();

        await workspace.fs.delete(
            Uri.file(path.join(STATIC_WORKSPACE_PATH, '.codechecker-alt')),
            { recursive: true, useTrash: false }
        );
    });

    test('CodeChecker version check out of the box', async function() {
        // If version is already checked, set to false to force a new check
        executorBridge['versionChecked'] = false;

        const versionSpy = sinon.spy(executorBridge, 'checkVersion');
        const statusWatch = processStatusChange();

        await openDocument(filePath);

        await assert.doesNotReject(() => statusWatch, 'CodeChecker analyzer-version errored');

        assert.ok(versionSpy.called, 'version check not called when file was opened');

        const isVersionChecked = await versionSpy.returnValues[0];
        assert.ok(
            isVersionChecked && executorBridge['versionChecked'],
            'does not work with clean CodeChecker out of the box'
        );

        await closeAllTabs();

        // Remove parse process started by window open
        executorBridge.stopMetadataTasks();
    }).timeout(5000);

    test('CodeChecker analysis on file via command', async function() {
        // TODO: Direct commands cannot be verified via sinon spy,
        // because they are not replaced inside VSCode's callback
        const analyzeSpy = sinon.spy(executorBridge, 'analyzeFile');
        const fileWatcher = workspace.createFileSystemWatcher(
            path.join(STATIC_WORKSPACE_PATH, '.codechecker-alt', 'reports', 'metadata.json')
        );

        let isFileChanged = false;

        fileWatcher.onDidCreate(() => isFileChanged = true);
        fileWatcher.onDidChange(() => isFileChanged = true);

        const statusWatch = processStatusChange();

        await commands.executeCommand(
            'codechecker.executor.analyzeSelectedFiles',
            filePath
        );

        await assert.doesNotReject(() => statusWatch, 'CodeChecker analyze errored');

        // Wait for file watcher events to register
        await new Promise((res) => setTimeout(res, 100));

        assert.ok(analyzeSpy.called, 'analyze file starter not called');

        assert.ok(isFileChanged, 'CodeChecker analysis did not set metadata on selected file');
    }).timeout(5000);

    test('CodeChecker analysis on project via command', async function() {
        const fileWatcher = workspace.createFileSystemWatcher(
            path.join(STATIC_WORKSPACE_PATH, '.codechecker-alt', 'reports', 'metadata.json')
        );

        let isFileChanged = false;

        fileWatcher.onDidCreate(() => isFileChanged = true);
        fileWatcher.onDidChange(() => isFileChanged = true);

        const statusWatch = processStatusChange();

        await commands.executeCommand('codechecker.executor.analyzeProject');

        await assert.doesNotReject(() => statusWatch, 'CodeChecker analyze errored');

        // Wait for file watcher events to register
        await new Promise((res) => setTimeout(res, 100));

        assert.ok(isFileChanged, 'CodeChecker analysis did not set metadata on project');
    }).timeout(5000);

    test('CodeChecker parse on analyzed files', async function() {
        const parseSpy = sinon.spy(executorBridge, 'parseMetadata');
        const fileWatcher = workspace.createFileSystemWatcher(
            path.join(STATIC_WORKSPACE_PATH, '.codechecker-alt', 'reports', 'metadata.json')
        );

        let isFileChanged = false;

        fileWatcher.onDidCreate(() => isFileChanged = true);
        fileWatcher.onDidChange(() => isFileChanged = true);

        const statusWatch = processStatusChange();

        await openDocument(filePath);

        await assert.doesNotReject(() => statusWatch, 'CodeChecker parse errored');
        assert.ok(parseSpy.called, 'parse not called when opening file');
        assert.ok(!isFileChanged, 'CodeChecker metadata changed by parse call');

        await closeAllTabs();
    }).timeout(5000);

    test('Re-parse when reports folder is changed', async function() {
        const initialStatusWatch = processStatusChange();
        await openDocument(filePath);
        await assert.doesNotReject(() => initialStatusWatch, 'CodeChecker parse errored');

        const statusWatch = processStatusChange();

        await updateOutputFolder(undefined);

        await assert.doesNotReject(() => statusWatch, 'CodeChecker parse errored in new folder');

        await updateOutputFolder('${workspaceFolder}/.codechecker-alt');
        await closeAllTabs();
    }).timeout(8000);

    test('Stop analysis cancels current task and clears the queue', async function() {
        await Promise.all([
            executorBridge.analyzeFile(Uri.file(path.join(STATIC_WORKSPACE_PATH, 'file.cpp'))),
            executorBridge.analyzeFile(Uri.file(path.join(STATIC_WORKSPACE_PATH, 'file2.cpp'))),
            executorBridge.analyzeFile(Uri.file(path.join(STATIC_WORKSPACE_PATH, 'file3.cpp')))
        ]);

        // The analysis tasks are slow enough that one will stay in the queue by this point.
        assert(executorManager['queue'].get(ProcessType.analyze)!.length > 0, 'Multiple entries not added to queue');
        assert(executorManager.activeProcess !== undefined, 'Process not started automatically');

        executorBridge.stopAnalysis();

        assert(executorManager['queue'].get(ProcessType.analyze)!.length === 0, 'Queue not cleared on analysis stop');
        assert(executorManager.activeProcess === undefined, 'Running process not killed');
    });

    test('Duplicate tasks are removed from the queue', async function() {
        await Promise.all([
            executorBridge.analyzeFile(Uri.file(path.join(STATIC_WORKSPACE_PATH, 'file.cpp'))),
            executorBridge.analyzeFile(Uri.file(path.join(STATIC_WORKSPACE_PATH, 'file.cpp'))),
            executorBridge.analyzeFile(Uri.file(path.join(STATIC_WORKSPACE_PATH, 'file.cpp')))
        ]);

        // When all tasks are queued, the queue should contain at most 1 element.
        // It's possible for that element to start executing before this assertion.
        assert(executorManager['queue'].get(ProcessType.analyze)!.length <= 1, 'Task queue is not deduplicated');

        executorBridge.stopAnalysis();
    });
});
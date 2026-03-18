#!/usr/bin/env node

const { Command } = require('commander');
const { loadConfig } = require('./utils/config');
const { initDb } = require('./database/db');
const { 
  createProject, 
  listProjects, 
  startSession, 
  setSessionState, 
  getActiveSession, 
  listSessions 
} = require('./services/session');
const { startWatcher } = require('./services/watcher');
const { getSuggestions } = require('./services/suggestions');
const { 
  getEligibleProjects, 
  archiveProject, 
  deleteProjectFiles, 
  keepProject 
} = require('./services/cleanup');
const chalk = require('chalk');
const readline = require('readline');
const path = require('path');

const config = loadConfig();
const db = initDb(config.dbPath);

const program = new Command();

program
  .name('claude-vault')
  .description('ClaudeVault: File Pipeline & Session Continuity System')
  .version('0.1.0');

// Project Commands
const project = program.command('project').description('Project management');

project
  .command('create <name>')
  .description('Create a new project')
  .action((name) => {
    try {
      const projectId = createProject(db, name);
      console.log(`${chalk.hex('#FF4B35').bold('PROJECT CREATED')} · ${name} · ${projectId}`);
    } catch (err) {
      console.error(`${chalk.red.bold('ERROR')} · ${err.message}`);
    }
  });

project
  .command('list')
  .description('List all projects')
  .action(() => {
    const projects = listProjects(db);
    console.log(chalk.hex('#FF4B35').bold('PROJECTS'));
    projects.forEach(p => {
      console.log(`↳ ${p.name} · ${p.project_id} · ${new Date(p.created_at).toLocaleString()}`);
    });
  });

// Session Commands
const session = program.command('session').description('Session management');

session
  .command('start <projectId>')
  .description('Start a new session for a project')
  .action((projectId) => {
    try {
      const sessionId = startSession(db, projectId);
      console.log(`${chalk.hex('#FF4B35').bold('SESSION STARTED')} · ${sessionId} · ${projectId}`);
    } catch (err) {
      console.error(`${chalk.red.bold('ERROR')} · ${err.message}`);
    }
  });

session
  .command('stop')
  .description('Stop the current active session')
  .action(() => {
    try {
      const activeSession = getActiveSession(db);
      if (!activeSession) {
        console.log(`${chalk.yellow.bold('NO ACTIVE SESSION')}`);
        return;
      }
      setSessionState(db, activeSession.session_id, 'CLOSED');
      console.log(`${chalk.hex('#FF4B35').bold('SESSION CLOSED')} · ${activeSession.session_id}`);
    } catch (err) {
      console.error(`${chalk.red.bold('ERROR')} · ${err.message}`);
    }
  });

session
  .command('set-state <state>')
  .description('Set the state of the active session (ACTIVE, NEAR_LIMIT, FINAL_WINDOW)')
  .action((state) => {
    try {
      const activeSession = getActiveSession(db);
      if (!activeSession) {
        console.log(`${chalk.yellow.bold('NO ACTIVE SESSION')}`);
        return;
      }
      setSessionState(db, activeSession.session_id, state.toUpperCase());
      console.log(`${chalk.hex('#FF4B35').bold('SESSION STATE UPDATED')} · ${state.toUpperCase()} · ${activeSession.session_id}`);
    } catch (err) {
      console.error(`${chalk.red.bold('ERROR')} · ${err.message}`);
    }
  });

session
  .command('list [projectId]')
  .description('List all sessions (optionally filtered by project)')
  .action((projectId) => {
    const sessions = listSessions(db, projectId);
    console.log(chalk.hex('#FF4B35').bold('SESSIONS'));
    sessions.forEach(s => {
      const statusColor = s.state === 'CLOSED' ? chalk.gray : chalk.hex('#FF4B35');
      console.log(`↳ ${statusColor(s.state)} · ${s.session_id} · ${s.project_id} · ${new Date(s.started_at).toLocaleString()}`);
    });
  });

// Watch Command
program
  .command('watch')
  .description('Start the file watcher')
  .action(() => {
    startWatcher(db, config);
    // Keep process alive
    process.stdin.resume();
  });

// Status Command
program
  .command('status')
  .description('Show system status')
  .action(() => {
    const activeSession = getActiveSession(db);
    console.log(chalk.hex('#FF4B35').bold('CLAUDE VAULT STATUS'));
    if (activeSession) {
      console.log(`↳ ${chalk.bold('ACTIVE SESSION')}: ${activeSession.session_id}`);
      console.log(`↳ ${chalk.bold('PROJECT ID')}:     ${activeSession.project_id}`);
      console.log(`↳ ${chalk.bold('STATE')}:          ${activeSession.state}`);
    } else {
      console.log(`↳ ${chalk.bold('ACTIVE SESSION')}: NONE`);
    }
    console.log(`↳ ${chalk.bold('WATCH DIR')}:      ${config.watchDir}`);
    console.log(`↳ ${chalk.bold('DB PATH')}:       ${config.dbPath}`);
  });

// Suggestion Command
program
  .command('suggestions [projectId]')
  .description('Show file suggestions for a project')
  .action((projectId) => {
    try {
      if (!projectId) {
        const activeSession = getActiveSession(db);
        if (activeSession) {
          projectId = activeSession.project_id;
        } else {
          console.error(`${chalk.red.bold('ERROR')} · PROJECT ID REQUIRED`);
          return;
        }
      }

      const suggestions = getSuggestions(db, projectId);
      console.log(chalk.hex('#FF4B35').bold('FILE SUGGESTIONS'));
      if (suggestions.length === 0) {
        console.log(`↳ ${chalk.gray('NO SUGGESTIONS')}`);
        return;
      }
      suggestions.forEach(s => {
        let opacity = 1.0;
        if (s.confidence === 'medium') opacity = 0.55;
        else if (s.confidence === 'low') opacity = 0.25;

        const colorStr = chalk.hex('#FF4B35');
        // Simple chalk approximation for opacity
        console.log(`↳ ${colorStr.bold(s.confidence.toUpperCase())} · ${chalk.bold(s.original_name)} · ${s.file_path}`);
        console.log(`  ${chalk.gray(`SCORE: ${s.score.toFixed(2)}`)}`);
      });
    } catch (err) {
      console.error(`${chalk.red.bold('ERROR')} · ${err.message}`);
    }
  });

// Cleanup Command
program
  .command('cleanup')
  .description('Check for old project files and prompt for cleanup')
  .action(async () => {
    try {
      const projects = await getEligibleProjects(db, config.cleanupTtlDays || 30);
      
      if (projects.length === 0) {
        console.log(`${chalk.gray('NO PROJECTS ELIGIBLE FOR CLEANUP')}`);
        return;
      }

      console.log(chalk.hex('#FF4B35').bold('PROJECT CLEANUP REQUIRED'));
      
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const ask = (query) => new Promise((resolve) => rl.question(query, resolve));

      for (const p of projects) {
        console.log(`\n↳ ${chalk.bold(p.project_name)} · ${p.project_id}`);
        console.log(`  ${chalk.gray(`FILES: ${p.file_count} · SIZE: ${(p.total_bytes / (1024 * 1024)).toFixed(2)} MB · OLDEST: ${new Date(p.oldest_file).toLocaleDateString()}`)}`);
        
        const answer = await ask(`  Action for ${p.project_name}? [A]rchive, [D]elete, [K]eep, [S]kip: `);
        const choice = answer.toUpperCase();

        if (choice === 'A') {
          const projectDir = path.join(config.projectStore, p.project_id);
          const archivePath = await archiveProject(db, p.project_id, projectDir, config.archiveDir);
          console.log(`  ${chalk.green.bold('ARCHIVED')} · ${archivePath}`);
        } else if (choice === 'D') {
          const confirm = await ask(`  Type project name "${p.project_name}" to confirm delete: `);
          if (confirm === p.project_name) {
            const projectDir = path.join(config.projectStore, p.project_id);
            await deleteProjectFiles(db, p.project_id, projectDir);
            console.log(`  ${chalk.red.bold('DELETED')} · ${p.project_name}`);
          } else {
            console.log(`  ${chalk.yellow('DELETE CANCELLED')} · NAME MISMATCH`);
          }
        } else if (choice === 'K') {
          await keepProject(db, p.project_id);
          console.log(`  ${chalk.blue.bold('KEPT')} · ${p.project_name} FOR 30 DAYS`);
        } else {
          console.log(`  ${chalk.gray('SKIPPED')}`);
        }
      }
      rl.close();
    } catch (err) {
      console.error(`${chalk.red.bold('ERROR')} · ${err.message}`);
    }
  });

program.parse();

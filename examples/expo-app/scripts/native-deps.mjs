#!/usr/bin/env node
// Prints name@version for each installed package that can change the native app:
// one with a podspec, an Expo module, an Android project or a config plugin, and
// the Expo and React Native tooling that prebuild and codegen run.
import fs from 'node:fs';
import path from 'node:path';

const store = path.join(process.cwd(), 'node_modules', '.pnpm');
const TOOLING = /^(@expo\/|@react-native\/|expo$|expo-|react-native$|react-native-|hermes-)/;
const NATIVE_FILES = ['expo-module.config.json', 'app.plugin.js', 'react-native.config.js'];

function isNative(dir) {
  const names = fs.readdirSync(dir);
  return (
    names.some(name => name.endsWith('.podspec') || NATIVE_FILES.includes(name)) ||
    fs.existsSync(path.join(dir, 'android', 'build.gradle')) ||
    fs.existsSync(path.join(dir, 'android', 'build.gradle.kts'))
  );
}

function packagesIn(modules) {
  const dirs = [];
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    const full = path.join(modules, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
        if (scoped.isDirectory()) dirs.push(path.join(full, scoped.name));
      }
    } else if (entry.isDirectory()) {
      dirs.push(full);
    }
  }
  return dirs;
}

const found = new Set();
for (const entry of fs.readdirSync(store)) {
  const modules = path.join(store, entry, 'node_modules');
  if (!fs.existsSync(modules)) continue;
  for (const dir of packagesIn(modules)) {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const { name, version } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!TOOLING.test(name) && !isNative(dir)) continue;
    found.add(`${name}@${version}`);
  }
}
process.stdout.write([...found].sort().join('\n') + '\n');

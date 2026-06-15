#!/bin/bash

# DataBento Skills Installation Script
# Installs prebuilt DataBento skills to ~/.claude/skills/

set -e

echo "📦 Installing DataBento Skills..."

# Define paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
SKILLS_SRC="$PROJECT_ROOT/skills"
SKILLS_MANIFEST="$PROJECT_ROOT/skills/manifest.json"
SKILLS_DIST="$PROJECT_ROOT/dist/skills"
CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
TARGET_DIR="$CLAUDE_SKILLS_DIR/databento"

# Ensure Claude skills directory exists
if [ ! -d "$CLAUDE_SKILLS_DIR" ]; then
  echo "⚠️  Creating ~/.claude/skills directory..."
  mkdir -p "$CLAUDE_SKILLS_DIR"
fi

# Remove old installation if exists
if [ -d "$TARGET_DIR" ]; then
  echo "🗑️  Removing old installation..."
  rm -rf "$TARGET_DIR"
fi

# Create target directory
echo "📁 Creating target directory..."
mkdir -p "$TARGET_DIR/scripts"

# Copy compiled scripts
echo "📋 Copying compiled scripts..."
if [ -d "$SKILLS_DIST/skills/databento/scripts" ]; then
  cp -r "$SKILLS_DIST/skills/databento/scripts/"* "$TARGET_DIR/scripts/"
elif [ -f "$PROJECT_ROOT/tsconfig.skills.json" ] && [ -f "$PROJECT_ROOT/package.json" ]; then
  echo "🔨 Compiled skills not found; building skills first..."
  (cd "$PROJECT_ROOT" && npm run build:skills)
  cp -r "$SKILLS_DIST/skills/databento/scripts/"* "$TARGET_DIR/scripts/"
else
  echo "❌ Error: Compiled skills not found. Reinstall the published package or run this from a source checkout with build files."
  exit 1
fi

# The compiled files are emitted under dist/skills/skills/databento/scripts and
# therefore import shared code as ../../../src. After installation, scripts live
# in databento/scripts next to databento/src, so runtime imports must be local.
for script_file in "$TARGET_DIR"/scripts/*.js; do
  sed -i.bak 's#../../../src/#../src/#g' "$script_file"
  rm -f "$script_file.bak"
done

# Copy SKILL.md
echo "📄 Copying SKILL.md..."
cp "$SKILLS_SRC/databento/SKILL.md" "$TARGET_DIR/"

# Copy manifest.json
echo "📋 Copying manifest.json..."
cp "$SKILLS_MANIFEST" "$TARGET_DIR/"

# Copy shared src files (needed at runtime)
echo "📦 Copying shared source files..."
mkdir -p "$TARGET_DIR/src"
cp -r "$SKILLS_DIST/src/"* "$TARGET_DIR/src/" 2>/dev/null || true

# Make scripts executable
echo "🔧 Making scripts executable..."
chmod +x "$TARGET_DIR/scripts/"*.js

# Update master manifest if it exists
MASTER_MANIFEST="$CLAUDE_SKILLS_DIR/manifest.json"
INSTALLED_MANIFEST="$TARGET_DIR/manifest.json"
if [ -f "$MASTER_MANIFEST" ]; then
  echo "📝 Updating master manifest..."
  # Backup existing manifest
  cp "$MASTER_MANIFEST" "$MASTER_MANIFEST.backup"

  if command -v node > /dev/null 2>&1; then
    node - "$MASTER_MANIFEST" "$INSTALLED_MANIFEST" <<'NODE'
const fs = require("node:fs");

const [masterManifestPath, installedManifestPath] = process.argv.slice(2);
const masterManifest = JSON.parse(fs.readFileSync(masterManifestPath, "utf8"));
const skillsManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
const databentoSkill = skillsManifest.skills.find((skill) => skill.name === "databento");

if (!databentoSkill) {
  throw new Error("databento skill entry not found in installed manifest");
}

const existingSkills = Array.isArray(masterManifest.skills)
  ? masterManifest.skills.filter((skill) => skill?.name !== "databento")
  : [];

masterManifest.skills = [...existingSkills, databentoSkill];
fs.writeFileSync(masterManifestPath, `${JSON.stringify(masterManifest, null, 2)}\n`);
NODE
    echo "✅ Master manifest updated with databento skill"
  else
    echo "⚠️  node not found. Please manually add databento to $MASTER_MANIFEST"
  fi
fi

echo "✅ DataBento skills installed successfully!"
echo ""
echo "📍 Installation location: $TARGET_DIR"
echo ""
echo "🔑 Don't forget to set DATABENTO_API_KEY environment variable:"
echo "   export DATABENTO_API_KEY='db-your-api-key-here'"
echo ""
echo "🧪 Test the installation with:"
echo "   node $TARGET_DIR/scripts/get-quote.js ES"
echo ""

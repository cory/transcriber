#!/bin/bash

# Pre-commit hook script to check for secrets
# Install as git hook: cp scripts/check-secrets.sh .git/hooks/pre-commit

echo "🔍 Checking for potential secrets..."

# Patterns to check for
patterns=(
  "sk-[A-Za-z0-9]{48}"  # OpenAI keys
  "AIza[A-Za-z0-9_-]{35}"  # Google/Gemini API keys
  "api[_-]?key.*['\"].*[A-Za-z0-9]{32,}"  # Generic API keys
)

files_to_check=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|js|json|env|txt|md)$')

if [ -z "$files_to_check" ]; then
  exit 0
fi

for pattern in "${patterns[@]}"; do
  matches=$(git diff --cached --name-only --diff-filter=ACM | xargs grep -l -E "$pattern" 2>/dev/null)

  if [ ! -z "$matches" ]; then
    echo "⚠️  Potential secret found matching pattern: $pattern"
    echo "Files: $matches"
    echo ""
    echo "If this is a false positive, you can:"
    echo "1. Use git commit --no-verify to skip this check"
    echo "2. Add the pattern to .gitleaks.toml allowlist"
    exit 1
  fi
done

echo "✅ No secrets detected"
exit 0
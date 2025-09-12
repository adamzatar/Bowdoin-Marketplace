# Changesets

This repository uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing across all workspaces.

## Workflow

1. **Add a changeset when making a change**
   ```sh
   pnpm changeset

	•	Select the affected packages.
	•	Choose the bump type: patch, minor, or major.
	•	Write a clear description of the change.

	2.	Commit the changeset file
	•	The command above creates a new file in .changeset/.
	•	Commit it alongside your code changes.
	3.	Create a release PR
	•	A GitHub Action will open a Version Packages PR once changesets exist.
	•	This PR shows all version bumps and changelog entries.
	4.	Merge the release PR
	•	Merging it will trigger CI to:
	•	Bump versions.
	•	Update changelogs.
	•	Publish packages (if applicable).

Configuration

See .changeset/config.json for the setup. Highlights:
	•	Base branch: main
	•	Publishing access: restricted
	•	Changelog generator: GitHub integration
	•	Internal dependency bumps: patch

Best Practices
	•	Group related changes into a single changeset.
	•	Use minor for backwards-compatible feature work.
	•	Use major only when introducing breaking changes (and document them clearly).
	•	If you need to update internal packages without publishing to the registry, use the ignore list in config.json.

Resources
	•	Changesets Documentation
	•	Versioning Strategy

⸻

Maintainers: Please do not manually bump versions or edit changelogs — always use Changesets to ensure consistency.
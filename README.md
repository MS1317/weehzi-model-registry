# Weehzi Model Context Registry

The Weehzi Model Context Registry is a public, remotely maintained source of model context-window information used by Weehzi.

Some AI providers do not expose context-window limits through their model APIs. This registry allows Weehzi to retrieve verified capability information without permanently embedding model-specific limits inside the application.

The registry contains information such as exact provider identifiers, exact model identifiers, context-window capacities, optional maximum output-token limits, and source verification details.

Weehzi uses exact model matching. It does not estimate context limits from model names, model families, prefixes, or similar models. When reliable information is unavailable, the context window remains unknown rather than being guessed.

The public registry file is:

`model-context-registry.json`

All published model information should be verified against authoritative provider documentation before being added or updated.

The registry is public and contains no API keys, credentials, personal information, user conversations, or private configuration.

Weehzi validates registry data before using it and preserves the last known valid version when a remote update is unavailable or invalid. Weehzi refuses the whole file when any single entry is invalid, so every change must keep the file valid.

## Two kinds of entries

**Entries written by a person.** Verify the value against the provider's own documentation, write the page you used in `provenance.source`, and add the entry to `model-context-registry.json` by hand. The update job never changes or removes these entries. If you write an entry for an NVIDIA model, the job stops writing its own entry for that model.

**NVIDIA entries written by the update job.** NVIDIA's model list (`https://integrate.api.nvidia.com/v1/models`) states no context sizes, but each model's page on `build.nvidia.com` does. The job in `.github/workflows/update-registry.yml` runs every day and reads those pages with `scripts/update-registry.mjs`. Its entries are the ones with `"provider": "nvidia"` whose `provenance.source` is exactly that model's `build.nvidia.com` page.

How the job decides:

- A page that states a size gives the model an entry. `verifiedAt` is when that value was first read; on a day when nothing changed, the job writes nothing.
- A page that fails, or that stops stating a size, never removes a recorded value. A change to NVIDIA's site must not wipe the registry. The job lists these in its run summary so a person can look.
- A model that leaves NVIDIA's model list is removed.
- When none of NVIDIA's pages give a size, or the result would not pass Weehzi's checks, the job writes nothing and the run fails, so the problem shows up as a red run.
- A push made with a job's own token does not rebuild the Pages site, so after a change the job asks GitHub for a Pages build.
- GitHub switches off a public repository's scheduled job after 60 days without activity. When nothing has changed for 45 days, the job makes an empty commit so the daily check keeps running.

To run it by hand: `node scripts/update-registry.mjs --dry-run` reads and reports without writing; without `--dry-run` it writes the file. `node --test scripts/registry.test.mjs` runs its tests. It needs Node.js 22 or newer and no key.

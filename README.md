# Weehzi Model Context Registry

The Weehzi Model Context Registry is a public, remotely maintained source of model context-window information used by Weehzi.

Some AI providers do not expose context-window limits through their model APIs. This registry allows Weehzi to retrieve verified capability information without permanently embedding model-specific limits inside the application.

The registry contains information such as exact provider identifiers, exact model identifiers, context-window capacities, optional maximum output-token limits, and source verification details.

Weehzi uses exact model matching. It does not estimate context limits from model names, model families, prefixes, or similar models. When reliable information is unavailable, the context window remains unknown rather than being guessed.

The public registry file is:

`model-context-registry.json`

All published model information should be verified against authoritative provider documentation before being added or updated.

The registry is public and contains no API keys, credentials, personal information, user conversations, or private configuration.

Weehzi validates registry data before using it and preserves the last known valid version when a remote update is unavailable or invalid.

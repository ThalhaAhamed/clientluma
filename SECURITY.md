# Security

Report security issues through a private GitHub vulnerability report when the repository enables them. If private reporting is unavailable, ask for a private contact without posting technical details.

The dashboard is a single-user local service. Keep it on loopback and expose only the documented MeetStream callback paths. Protect the local data directory with operating-system permissions. API keys belong in environment variables or an ignored `.env` file.

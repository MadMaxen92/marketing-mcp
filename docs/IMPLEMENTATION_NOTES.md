# Implementation notes

The first version deliberately minimizes infrastructure:

- No separate database is required.
- No Google service-account key is required.
- No OpenAI API is used.
- Google accounts are connected through the owner's OAuth client.
- ChatGPT Work communicates only with the remote MCP endpoint.

A database can replace the encrypted file store when horizontal scaling or team administration becomes necessary.

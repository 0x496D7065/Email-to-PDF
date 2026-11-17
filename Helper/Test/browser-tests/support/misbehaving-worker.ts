// TEST-ONLY worker for Helper/Test/browser-tests/parse-files.spec.ts. Never part of the site: only
// Helper/Test/browser-tests/support/parse-entry.ts starts it, and that entry is bundled in memory
// by the spec, never into dist/.
//
// It stands in for a parser (or the engine) that goes wrong in ways
// try/catch cannot handle, chosen by the `name` field of the first message
// (the file name of a parse request; parse-entry.ts sends 'hang' or 'crash'
// as the name when it stands in for the engine worker):
// - a name containing "hang": spins forever without allocating (like a parser
//   stuck in a loop), so only terminate() can stop it;
// - any other name: throws an uncaught error (like a parser crash), which
//   the page sees as the worker's 'error' event.

interface WorkerScope
{
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) =>
{
    const data = event.data as { name?: unknown };
    const name = typeof data.name === 'string' ? data.name : '';
    if (name.includes('hang'))
    {
        for (;;)
        {
            // Never returns: the page must terminate this worker.
        }
    }
    throw new Error('synthetic worker crash');
};

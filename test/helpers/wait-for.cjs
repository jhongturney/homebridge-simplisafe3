module.exports = async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Fixture operation did not reach the expected state');
        await new Promise(setImmediate);
    }
};

/**
 * @renderflow/outbox
 *
 * The transactional outbox: request handlers write state and an event in one
 * transaction, and this relay publishes the event afterwards.
 *
 * AGENTS.md section 6 forbids pushing to a queue from a request handler, and
 * this is why that is safe rather than merely tidy: a crash between the commit
 * and the publish leaves the row unprocessed, and the next poll picks it up.
 */

export * from './relay';
export * from './bullmq-publisher';

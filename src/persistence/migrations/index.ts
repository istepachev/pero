import { InitialSchema1790839859674 } from './1790839859674-InitialSchema.js';
import { ChannelContext1790881153233 } from './1790881153233-ChannelContext.js';

/**
 * Every migration in the order it runs, listed explicitly so the compiled
 * package ships them without file globbing. Append new migrations here.
 */
export const MIGRATIONS = [
  InitialSchema1790839859674,
  ChannelContext1790881153233,
];

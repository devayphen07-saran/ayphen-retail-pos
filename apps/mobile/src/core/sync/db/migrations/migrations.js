// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_noisy_guardian.sql';
import m0001 from './0001_tidy_goliath.sql';
import m0002 from './0002_open_red_skull.sql';
import m0003 from './0003_rare_anita_blake.sql';
import m0004 from './0004_brief_harrier.sql';

  export default {
    journal,
    migrations: {
      m0000,
m0001,
m0002,
m0003,
m0004
    }
  }
  
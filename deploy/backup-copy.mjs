import { backupData, verifyBackup } from '../data-storage.mjs';
const destination = process.argv[2];
if (!destination) throw Error('Backup destination is required');
const folder = await backupData({ destination });
verifyBackup(folder);
process.stdout.write(folder + '\n');

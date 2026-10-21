import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
for (const scenario of ['success','copy-failure','offsite-failure','stop-failure','restart-failure']) {
  test(`backup orchestration ${scenario}: restart and conditional retention`, () => {
    const root=mkdtempSync(join(tmpdir(),'itd-backup-shell-'));
    try {
      const bin=join(root,'bin'),folder=join(root,'verified'),log=join(root,'commands'),marker=join(root,'restart');
      mkdirSync(bin);mkdirSync(folder);writeFileSync(join(folder,'backup.json'),'{}');
      const executable=(name,body)=>writeFileSync(join(bin,name),'#!/bin/bash\nset -eu\n'+body+'\n',{mode:0o700});
      executable('systemctl','echo "systemctl $*" >> "$TEST_LOG"\nif [[ "$TEST_SCENARIO" == stop-failure && "$1" == stop ]]; then exit 11; fi\nif [[ "$TEST_SCENARIO" == restart-failure && "$1" == start ]]; then exit 12; fi\nexit 0');
      executable('runuser','echo "copy" >> "$TEST_LOG"\nif [[ "$TEST_SCENARIO" == copy-failure ]]; then exit 9; fi\necho "$TEST_FOLDER"');
      executable('restic','echo "restic $*" >> "$TEST_LOG"\nif [[ "$TEST_SCENARIO" == offsite-failure && "$1" == backup ]]; then exit 10; fi');
      const config=join(root,'backup.env');
      writeFileSync(config,`ITD_USER=fictional\nITD_HOME=${root}\nITD_APP_DIR=${root}\nITD_BACKUP_DIR=${root}\nITD_SERVICE=itd-studio.service\nRESTIC_REPOSITORY=fictional-test-repository\nRESTIC_PASSWORD_FILE=${root}/not-a-real-key\nKEEP_DAILY=3\nKEEP_WEEKLY=2\nKEEP_MONTHLY=1\n`);
      const result=spawnSync('/bin/bash',[resolve('deploy/backup.sh'),config],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,TEST_LOG:log,TEST_FOLDER:folder,TEST_SCENARIO:scenario,ITD_BACKUP_LOCK:join(root,'lock'),ITD_RESTART_MARKER:marker}});
      const commands=readFileSync(log,'utf8');
      assert.equal(result.status,({success:0,'copy-failure':9,'offsite-failure':10,'stop-failure':11,'restart-failure':1})[scenario],result.stderr);
      assert.match(commands,/systemctl stop itd-studio.service/);
      assert.match(commands,/systemctl start itd-studio.service/);
      assert.equal(existsSync(marker),scenario==='restart-failure');
      assert.equal(commands.includes('restic forget'),scenario==='success');
      if(scenario==='copy-failure')assert.equal(commands.includes('restic backup'),false);
      if(scenario==='success')assert.match(commands,/--group-by host,tags --keep-daily 3 --keep-weekly 2 --keep-monthly 1 --prune/);
    } finally {rmSync(root,{recursive:true,force:true});}
  });
}

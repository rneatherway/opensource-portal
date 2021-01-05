//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

/*eslint no-console: ["error", { allow: ["warn", "log", "dir"] }] */

// The local environment script is designed to allow for local debugging, test and
// development scenarios. The go method is called with resolved configuration.

import _ from 'lodash';

async function go(providers: IProviders): Promise<void> {
  // ---------------------------------------------------------------------------

  const { microsoftMetadataProvider, operations } = providers;

  const orgNames = ['microsoft', 'Azure', 'OfficeDev'];
  const orgz = operations.getOrganizations().filter(org => orgNames.includes(org.name));
  let publicRepos = 0;
  let privateRepos = 0;
  const repoIds = new Set<number>();
  const privateRepoIds = new Set<number>();
  const microsoftOrgRepoIds = new Set<number>();
  const okrOrgRepoIds = new Set<number>();
  let ignoredArchives = 0;
  let archivedMicrosoftRepos = 0;
  for (let i = 0; i < orgz.length; i++) {
    const org = orgz[i];
    console.log('temp - slow');
    const repos = await org.getRepositories(); // {backgroundRefresh: false, maxAgeSeconds: 0, });
    console.log('k');
    const rids = repos.filter(r => !r.archived).map(r => r.id);
    const archivedRids = repos.filter(r => r.archived).map(r => r.id);
    console.log(`org ${org.name} has archived repos: ${archivedRids.length}`);
    //if (org.name === 'microsoft') {
      archivedMicrosoftRepos = archivedRids.length;
    //}
    repos.forEach(repo => {
      if (repo.archived === true) {
        ++ignoredArchives;
      } else if (repo.private === true) {
        privateRepoIds.add(repo.id);
      }
    });
    rids.forEach(id => {
      repoIds.add(id);
      if (org.name === 'microsoft') {
        microsoftOrgRepoIds.add(id);
      }
      if (orgNames.includes(org.name)) {
        okrOrgRepoIds.add(id);
      }
    });
    publicRepos += (repos.filter(repo => !repo.private).length);
    privateRepos += (repos.filter(repo => true === repo.private).length);
  }

  console.log(`Private repos UNARCHIVED across ${orgNames.join(', ')}= ${privateRepos};`)
  console.log(`Public repos in these orgs: ${publicRepos}`);
  console.log(`Total repos in these orgs: ${publicRepos + privateRepos}`);
  console.log(`Ignored, archived repos: ${ignoredArchives}`);

  const allMaintainerEntries = await microsoftMetadataProvider.getAllMaintainers();

console.log(`count of repos with maintainers assigned across all: ${allMaintainerEntries.length}`);

  const focusedPrivateRepos = privateRepoIds.size;
  console.log(`focused private repo count: ${focusedPrivateRepos}`);
  const privateSubsetMaintainers = allMaintainerEntries.filter(r => privateRepoIds.has(Number(r.repositoryId)));
  console.log(`subset with maintainers: ${privateSubsetMaintainers.length}`);
  console.log(`percent: ${privateSubsetMaintainers.length / focusedPrivateRepos}`);
  console.log(`OKR goal of 70%... == ${(privateSubsetMaintainers.length / focusedPrivateRepos)/.7}%`)
  console.log();

  const msftOrgMaintainers = allMaintainerEntries.filter(r => microsoftOrgRepoIds.has(Number(r.repositoryId)));
  console.log(`Microsoft org repos: ${microsoftOrgRepoIds.size}`);
  console.log(`+ with set maintainrs: ${msftOrgMaintainers.length}`);
  console.log(`+ percent: ${(msftOrgMaintainers.length / microsoftOrgRepoIds.size).toFixed(3)}%`);
  console.log(`FY21Q2 OKR stretch goal of 40%... == ${((msftOrgMaintainers.length / microsoftOrgRepoIds.size)/.4).toFixed(3)}%`);

  const dec6 = new Date(1607445729429 - (1000 * 60 * 60 * 42));
  const okrOrgMaintainers = allMaintainerEntries.filter(r => okrOrgRepoIds.has(Number(r.repositoryId)));
  const updatedSinceDec6 = allMaintainerEntries.filter(x => new Date(x.maintainerUpdated) > dec6);
  const msftOrgMaintainersSinceDec6 = msftOrgMaintainers.filter(x => new Date(x.maintainerUpdated) > dec6);
  console.log(`Maintainer entries updated since push: ${updatedSinceDec6.length}`);
  console.log(`Maintainer entries updated since push in Microsoft org: ${msftOrgMaintainersSinceDec6.length}`);
  console.log(`FY21Q3 OKR: 100% of Microsoft, OfficeDev, Azure org repos exc. deleted and archived: ${okrOrgMaintainers.length / okrOrgRepoIds.size}%`);
  console.log(`FYI archived repos in the  Microsoft, OfficeDev, Azure org: ${archivedMicrosoftRepos}`);

  console.log('---');
  console.log();

  const all = await microsoftMetadataProvider.getAllEnterpriseAnswers();
  console.log(`Total: ${all.length}`);
  console.log(`Opt-in: ${all.filter(f => f.enterpriseOptIn).length}`);
  console.log(`Opt-out: ${all.filter(f => !f.enterpriseOptIn).length}`);




















}













// -----------------------------------------------------------------------------
// Local script initialization
// -----------------------------------------------------------------------------
import app, { IReposJob } from '../app';
import { IProviders } from '../transitional';
console.log('Initializing the local environment...');

app.runJob(async function ({ providers }: IReposJob) {
  await go(providers);
  return {};
}, {
  treatGitHubAppAsBackground: false,
});

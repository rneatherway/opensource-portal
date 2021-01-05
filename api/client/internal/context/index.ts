//
// Copyright (c) Microsoft. All Rights Reseved.
//

import express from 'express';
import asyncHandler from 'express-async-handler';

import RouteIndividualContextualOrganization from './organization';
import RouteApprovals from './approvals';
import RouteContribution from './contribution';
import RouteShruti from './shruti';

import { IndividualContext } from '../../../../user';
import { jsonError } from '../../../../middleware/jsonError';
import { ErrorHelper, IProviders, ReposAppRequest } from '../../../../transitional';
import { Organization } from '../../../../business/organization';
import { GitHubRepositoryPermission } from '../../../../entities/repositoryMetadata/repositoryMetadata';
import { TeamJsonFormat } from '../../../../business/team';

import LeakyLocalCache from '../leakyLocalCache';
import { MicrosoftMetadata } from '../../../../microsoft/entities/msftMetadata';
import { shuffle } from 'lodash';

const router = express.Router();

// BAD PRACTICE: leaky local cache
// CONSIDER: use a better approach
const leakyLocalMetadata = new LeakyLocalCache<boolean, MicrosoftMetadata[]>();

router.get('/', (req: ReposAppRequest, res, next) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const data = {
    corporateIdentity: activeContext.corporateIdentity,
    githubIdentity: activeContext.getGitHubIdentity(),
    isAuthenticated: true,
    isLinked: !!activeContext.link,
  };
  return res.json(data);
});

router.get('/accountDetails', asyncHandler(async (req: ReposAppRequest, res) => {
  const { operations} = req.app.settings.providers as IProviders;
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  const gh = activeContext.getGitHubIdentity();
  if (!gh || !gh.id) {
    res.status(400);
    res.end();
  }
  const accountFromId = operations.getAccount(gh.id);
  const accountDetails = await accountFromId.getDetails();
  res.json(accountDetails);
}));

router.use('/approvals', RouteApprovals);

router.use('/contribution', RouteContribution);

router.use('/ghaeTemporary', RouteShruti);

router.get('/orgs', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  if (!activeContext.link) {
    return res.json({
      member: [],
      admin: [],
      isLinked: false,
    });
  }
  const orgs = await activeContext.aggregations.getQueryCacheOrganizations();
  const data = {
    isLinked: true,
    member: orgs.member.map(org => {
      return {
        name: org.name,
        id: org.id,
      };
    }),
    admin: orgs.admin.map(org => {
      return {
        name: org.name,
        id: org.id,
      }
    }),
  };
  return res.json(data);
}));

router.get('/reposWithoutMaintainers', asyncHandler(async (req: ReposAppRequest, res) => {
  const { microsoftMetadataProvider, operations } = req.app.settings.providers as IProviders;
  let allMetadatas = leakyLocalMetadata.get(true);
  if (!allMetadatas) {
    allMetadatas = await microsoftMetadataProvider.getAllMaintainers();
    leakyLocalMetadata.set(true, allMetadatas);
  }
  const reposWithMaintainers = new Set<number>(allMetadatas.map(m => Number(m.repositoryId)));
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  if (!activeContext.link) {
    return res.json({
      isLinked: false,
      repositories: [],
    });
  }
  let permissions = await activeContext.aggregations.getQueryCacheRepositoryPermissions();
  const archivedRepos = new Set();
  const uniqueOrgs = new Set(permissions.map(perm => perm.repository.organization.name));
  for (let org in uniqueOrgs) {
    try {
      const organization = operations.getOrganization(org);
      const ar = (await organization.getRepositories()).filter(r => r.archived);
      ar.forEach(repo => archivedRepos.add(Number(repo.id)));
      console.log(`org ${organization.name} has ${ar.length} archived repos`);
    } catch (ignoreError) { /* ignore */ }
  }
  permissions = permissions.filter(perm => {
    const orgSettings = perm.repository.organization.getDynamicSettings();
    // .NET orgs are exempt from maintainers for now
    if (orgSettings && orgSettings.hasFeature('dotnetexempt')) {
      return false;
    }
    // Exclude archived repos
    if (archivedRepos.has(Number(perm.repository.id))) {
      console.log(`excluding archived repo ID: ${perm.repository.id}`);
      return false;
    }
    // Exclude if there is metadata
    if (reposWithMaintainers.has(Number(perm.repository.id))) {
      return false;
    }
    // Only want to grant admin rights
    if (perm.bestComputedPermission !== GitHubRepositoryPermission.Admin) {
      return false;
    }
    let fromBroadAccess = false;
    perm.teamPermissions.map(tp => {
      if (tp.team.isBroadAccessTeam) {
        fromBroadAccess = true;
      }
    });
    if (fromBroadAccess) {
      // Do not want to key off of those
      return false;
    }
    return true;
  });
  permissions = (shuffle(permissions)).slice(0, 30); // cap at 30
  return res.json({
    isLinked: true,
    repositories: permissions.map(perm => { return { repository: perm.repository.asJson() } }),
  });
}));

router.get('/repos', asyncHandler(async (req: ReposAppRequest, res) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  if (!activeContext.link) {
    return res.json({
      isLinked: false,
      repositories: [],
    });
  }
  let permissions = await activeContext.aggregations.getQueryCacheRepositoryPermissions();
  permissions = permissions.filter(perm => {
    if (perm.bestComputedPermission !== GitHubRepositoryPermission.Pull) {
      return true;
    }
    let fromBroadAccess = false;
    perm.teamPermissions.map(tp => {
      if (tp.team.isBroadAccessTeam) {
        fromBroadAccess = true;
      }
    });
    if (fromBroadAccess) {
      return false;
    }
    if (perm.repository.private) {
      return true;
    }
    return false;
  });
  return res.json({
    isLinked: true,
    repositories: permissions.map(perm => {
      return {
        bestComputedPermission: perm.bestComputedPermission,
        collaboratorPermission: perm.collaboratorPermission,
        repository: perm.repository.asJson(),
        teamPermissions: perm.teamPermissions.map(tp => tp.asJson()),
        // TODO: would be nice for team permission for repos to also store the team slug in the query cache!
      };
    }),
  });
}));

router.get('/teams', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  if (!activeContext.link) {
    return res.json({
      isLinked: false,
      member: [],
      maintainer: [],
    })
  }
  const permissions = await activeContext.aggregations.getQueryCacheTeams();
  return res.json({
    isLinked: true,
    member: permissions.member.map(t => t.asJson(TeamJsonFormat.Augmented)),
    maintainer: permissions.maintainer.map(t => t.asJson(TeamJsonFormat.Augmented)),
  });
}));

router.use('/orgs/:orgName', asyncHandler(async (req: ReposAppRequest, res, next) => {
  const { orgName } = req.params;
  const { operations } = req.app.settings.providers as  IProviders;
  // const activeContext = (req.individualContext || req.apiContext) as IndividualContext;
  // if (!activeContext.link) {
  //   return next(jsonError('Account is not linked', 400));
  // }
  let organization: Organization = null;
  try {
    organization = operations.getOrganization(orgName);
    // CONSIDER: what if they are not currently a member of the org?
    req.organization = organization;
    return next();
  } catch (noOrgError) {
    if (ErrorHelper.IsNotFound(noOrgError)) {
      res.status(404);
      return res.end();
    }
    return next(jsonError(noOrgError, 500));
  }
}));

router.use('/orgs/:orgName', RouteIndividualContextualOrganization);

router.use('*', (req: ReposAppRequest, res, next) => {
  return next(jsonError('Contextual API or route not found', 404));
});

export default router;

//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
const router = express.Router();

import _ from 'lodash';

import { ReposAppRequest, IProviders, INewRepoMicrosoftMetadata, IMicrosoftMetadataServiceTree } from '../../transitional';
import { jsonError } from '../../middleware/jsonError';
import { IndividualContext } from '../../user';
import { Organization } from '../../business/organization';
import { CreateRepository, ICreateRepositoryApiResult, CreateRepositoryEntrypoint } from '../createRepo';
import { Team, GitHubTeamRole } from '../../business/team';
import { asNumber, sleep } from '../../utils';
import { MicrosoftClassification } from '../../microsoft/entities/msftMetadata';

// This file supports the client apps for creating repos.

interface ILocalApiRequest extends ReposAppRequest {
  apiVersion?: string;
  organization?: Organization;
  knownRequesterMailAddress?: string;
}

router.get('/metadata', (req: ILocalApiRequest, res, next) => {
  try {
    const options = {
      projectType: req.query.projectType,
    };
    const organization = req.organization as Organization;
    const metadata = organization.getRepositoryCreateMetadata(options);
    res.json(metadata);
  } catch (error) {
    return next(jsonError(error, 400));
  }
});

router.get('/personalizedTeams', asyncHandler(async (req: ILocalApiRequest, res, next) => {
  try {
    const organization = req.organization as Organization;
    const userAggregateContext = req.apiContext.aggregations;
    const maintainedTeams = new Set<string>();
    const broadTeams = new Set<number>(req.organization.broadAccessTeams);
    const userTeams = userAggregateContext.reduceOrganizationTeams(organization, await userAggregateContext.teams());
    userTeams.maintainer.map(maintainedTeam => maintainedTeams.add(maintainedTeam.id.toString()));
    const combinedTeams = new Map<string, Team>();
    userTeams.maintainer.map(team => combinedTeams.set(team.id.toString(), team));
    userTeams.member.map(team => combinedTeams.set(team.id.toString(), team));
    const personalizedTeams = Array.from(combinedTeams.values()).map(combinedTeam => {
      return {
        broad: broadTeams.has(asNumber(combinedTeam.id)),
        description: combinedTeam.description,
        id: asNumber(combinedTeam.id),
        name: combinedTeam.name,
        role: maintainedTeams.has(combinedTeam.id.toString()) ? GitHubTeamRole.Maintainer : GitHubTeamRole.Member,
      }
    });
    return res.json({
      personalizedTeams,
    });
  } catch (error) {
    return next(jsonError(error, 400));
  }
}));

router.get('/teams', asyncHandler(async (req: ILocalApiRequest, res, next) => {
  const providers = req.app.settings.providers as IProviders;
  const queryCache = providers.queryCache;
  const organization = req.organization as Organization;
  const broadTeams = new Set(organization.broadAccessTeams);
  if (req.query.refresh === undefined && queryCache && queryCache.supportsTeams) {
    // Use the newer method in this case...
    const organizationTeams = await queryCache.organizationTeams(organization.id.toString());
    return res.json({
      teams: organizationTeams.map(qt => {
        const team = qt.team;
        const t = team.toSimpleJsonObject();
        if (broadTeams.has(asNumber(t.id))) {
          t['broad'] = true;
        }
        return t;
      }),
    });
  }

  // By default, allow a 30-second old list of teams. If the cached
  // view is older, refresh this list in the background for use if
  // they refresh for a better user experience.
  const caching = {
    backgroundRefresh: true,
    maxAgeSeconds: 30,
  };

  // If the user forces a true refresh, force a true walk of all the teams
  // from GitHub. This will be slow the larger the org. Allow a short cache
  // window for the casewhere a  webhook processes the change quickly.
  if (req.query.refresh) {
    caching.backgroundRefresh = false;
    caching.maxAgeSeconds = 10;
  }

  try {
    const teams = await organization.getTeams();
    const simpleTeams = teams.map(team => {
      const t = team.toSimpleJsonObject();
      if (broadTeams.has(t.id)) {
        t['broad'] = true;
      }
      return t;
    });
    res.json({
      teams: simpleTeams,
    });
  } catch (getTeamsError) {
    return next(jsonError(getTeamsError, 400));
  }
}));

router.get('/repo/:repo', asyncHandler(async (req: ILocalApiRequest, res) => {
  const repoName = req.params.repo;
  let error = null;
  try {
    const repo = await req.organization.repository(repoName).getDetails();
    res.json(repo);
  } catch (repoDetailsError) {
    res.status(404).end();
    error = repoDetailsError;
  }
  req.app.settings.providers.insights.trackEvent({
    name: 'ApiClientNewRepoValidateAvailability',
    properties: {
      found: error ? true : false,
      repoName,
      org: req.organization.name,
    },
  });
}));

export async function discoverUserIdentities(req: ReposAppRequest, res, next) {
  const apiContext = req.apiContext as IndividualContext;
  const providers = req.app.settings.providers as IProviders;
  const mailAddressProvider = providers.mailAddressProvider;
  // Try and also learn if we know their e-mail address to send the new repo mail to
  const upn = apiContext.corporateIdentity.username;
  if (apiContext.link && apiContext.link.corporateMailAddress) {
    req['knownRequesterMailAddress'] = apiContext.link.corporateMailAddress;
    return next();
  }
  try {
    const mailAddress = await mailAddressProvider.getAddressFromUpn(upn);
    if (mailAddress) {
      req['knownRequesterMailAddress'] = mailAddress;
    }
  } catch (ignoredError) { /* ignored */ }
  return next();
}

router.post('/repo/:repo', asyncHandler(discoverUserIdentities), asyncHandler(createRepositoryFromClient));

export async function createRepositoryFromClient(req: ILocalApiRequest, res, next) {
  const providers = req.app.settings.providers as IProviders;
  const { insights, diagnosticsDrop } = providers;
  const individualContext = req.individualContext || req.apiContext;
  const config = req.app.settings.runtimeConfig;
  const organization = req.organization as Organization;
  const existingRepoId = req.body.existingrepoid;
  const correlationId = req.correlationId;
  const debugValues = req.body.debugValues || {};
  const microsoftMetadata = req.body.msftMetadata || {};
  const corporateId = individualContext.corporateIdentity.id;
  insights.trackEvent({
    name: 'CreateRepositoryFromClientStart',
    properties: {
      debugValues,
      correlationId,
      body: JSON.stringify(req.body),
      query: JSON.stringify(req.query),
      microsoftMetadata: JSON.stringify(microsoftMetadata),
      corporateId,
    },
  });
  if (diagnosticsDrop) {
    diagnosticsDrop.setObject(`newrepo.${organization.name}.${correlationId}`, {
      debugValues,
      correlationId,
      body: req.body,
      query: req.query,
      microsoftMetadata,
      corporateId,
    });
  }
  if (organization.createRepositoriesOnGitHub && !(existingRepoId && organization.isNewRepositoryLockdownSystemEnabled())) {
    return next(jsonError(`The GitHub organization ${organization.name} is configured as "createRepositoriesOnGitHub": repos should be created on GitHub.com directly and not through this wizard.`, 400));
  }
  const body = req.body;
  if (!body) {
    return next(jsonError('No body', 400));
  }
  if (microsoftMetadata) {
    try {
      await validateMicrosoftMetadata(providers, microsoftMetadata);
    } catch (validationError) {
      return next(jsonError(validationError, 400));
    }
  }
  req.apiVersion = (req.query['api-version'] || req.headers['api-version'] || '2017-07-27') as string;
  if (req.apiContext && req.apiContext.getGitHubIdentity()) {
    body['ms.onBehalfOf'] = req.apiContext.getGitHubIdentity().username;
  }
  // these fields do not need translation: name, description, private
  const approvalTypesToIds = config.github.approvalTypes.fields.approvalTypesToIds;
  if (approvalTypesToIds[body.approvalType]) {
    body.approvalType = approvalTypesToIds[body.approvalType];
  } else {
    let valid = false;
    Object.getOwnPropertyNames(approvalTypesToIds).forEach(key => {
      if (approvalTypesToIds[key] === body.approvalType) {
        valid = true;
      }
    })
    if (!valid) {
      return next(jsonError('The approval type is not supported or approved at this time', 400));
    }
  }
  // Property supporting private repos from the client
  if (body.visibility === 'private') {
    body.private = true;
    delete body.visibility;
  }
  translateValue(body, 'approvalType', 'ms.approval');
  translateValue(body, 'approvalUrl', 'ms.approval-url');
  translateValue(body, 'justification', 'ms.justification');
  translateValue(body, 'legalEntity', 'ms.entity');
  translateValue(body, 'projectType', 'ms.project-type');
  // Team permissions
  if (!body.selectedAdminTeams || !body.selectedAdminTeams.length) {
    return next(jsonError('No administration team(s) provided in the request', 400));
  }
  translateTeams(body);
  // Initial repo contents and license
  const templates = _.keyBy(organization.getRepositoryCreateMetadata().templates, 'id');
  const template = templates[body.template];
  // if (!template) {
    // return next(jsonError('There was a configuration problem, the template metadata was not available for this request', 400));
  // }
  translateValue(body, 'template', 'ms.template');
  body['ms.license'] = template && (template.spdx || template.name); // Today this is the "template name" or SPDX if available
  translateValue(body, 'gitIgnoreTemplate', 'gitignore_template');
  if (!body['ms.notify']) {
    body['ms.notify'] = req.knownRequesterMailAddress || config.brand.operationsMail || config.brand.supportMail;
  }
  // these fields are currently ignored: orgName
  delete body.orgName;
  delete body.claEntity; // a legacy value
  // specific fields used by the client tooling
  delete body.debugValues;
  delete body.microsoftMetadata;
  insights.trackEvent({
    name: 'ApiClientNewOrgRepoStart',
    properties: {
      body: JSON.stringify(req.body),
    },
  });
  let success: ICreateRepositoryApiResult = null;
  try {
    success = await CreateRepository(req, body, CreateRepositoryEntrypoint.Client, individualContext);
  } catch (createRepositoryError) {
    insights.trackEvent({
      name: 'ApiClientNewOrgRepoError',
      properties: {
        error: createRepositoryError.message,
        encoded: JSON.stringify(createRepositoryError),
      },
    });
    if (!createRepositoryError.json) {
      createRepositoryError = jsonError(createRepositoryError, 400);
    }
    return next(createRepositoryError);
  }
  await configureMicrosoftMetadata(req.app.settings.providers as IProviders, corporateId, existingRepoId || success.github.id, microsoftMetadata);
  let message = success.github ? `Your new repo, ${success.github.name}, has been created:` : 'Your repo request has been submitted.';
  if (existingRepoId && success.github) {
    message = `Your repository ${success.github.name} is classified and the repo is now ready, unlocked, with your selected team permissions assigned.`;
  }
  const output = {
    ...success,
    title: existingRepoId ? 'Repository unlocked' : 'Repository created',
    message,
    url: null,
    messages: null,
  };
  if (success.github) {
    output.url = success.github.html_url;
  }
  output.messages = output['tasks'];
  delete output['tasks'];
  insights.trackEvent({
    name: 'ApiClientNewOrgRepoSuccessful',
    properties: {
      body: JSON.stringify(body),
      success: JSON.stringify(output),
    },
  });
  return res.json(output);
}

async function configureMicrosoftMetadata(providers: IProviders, corporateId: string, repositoryId: number, bodyMetadata: any): Promise<void> {
  if (!bodyMetadata) {
    return;
  }
  const { microsoftMetadataProvider, insights } = providers;
  try {
    const { maintainers, serviceTree, classification } = projectMicrosoftMetadata(bodyMetadata);
    const metadata = await microsoftMetadataProvider.getOrCreateMetadata(String(repositoryId));
    let update = false;
    if (classification) {
      metadata.classification = classification;
      metadata.classificationUpdated = new Date();
      metadata.classificationUpdatedBy = corporateId;
    }
    if (maintainers.securityGroup) {
      metadata.maintainerSecurityGroup = maintainers.securityGroup;
      metadata.maintainerUpdated = new Date();
      metadata.maintainerUpdatedBy = corporateId;
      update = true;
    }
    if (maintainers.individuals && maintainers.individuals.length > 0) {
      // is a replace, not an upsert
      metadata.maintainerCorporateIds = maintainers.individuals.join(',');
      metadata.maintainerUpdated = new Date();
      metadata.maintainerUpdatedBy = corporateId;
      update = true;
    }
    if (serviceTree && serviceTree.id) {
      const isExempt = serviceTree.id === 'N/A';
      metadata.serviceTreeExempt = isExempt;
      metadata.serviceTreeNode = isExempt === false ? serviceTree.id : null;
      metadata.serviceTreeUpdated = new Date();
      metadata.serviceTreeUpdatedBy = corporateId;
      update = true;
    }
    // TODO: Classification, when ready
    if (update) {
      await microsoftMetadataProvider.replaceMetadata(metadata);
    }
  } catch (metadataSetError) {
    insights.trackException({ exception: metadataSetError, properties: { event: 'ConfigureMicrosoftMetadataNewRepo' } });
    // ROBUSTNESS: rollback or?
    // CONSIDER: best options after the repo is created but the metadata set has issues
  }
}

async function validateMicrosoftMetadata(providers: IProviders, bodyMetadata: any) {
  try {
    const projected = projectMicrosoftMetadata(bodyMetadata);
    // TODO: verify the individuals
    console.dir(projected);
  } catch (error) {
    throw jsonError(error, 400);
  }
}

function projectMicrosoftMetadata(bodyMetadata: any): INewRepoMicrosoftMetadata {
  const metadata: INewRepoMicrosoftMetadata = {};
  if (bodyMetadata?.serviceTree) {
    metadata.serviceTree = bodyMetadata.serviceTree as IMicrosoftMetadataServiceTree;
  }
  if (bodyMetadata?.maintainers) {
    metadata.maintainers = {
      individuals: [],
      securityGroup: bodyMetadata.maintainers.securityGroup,
    };
    for (let i = 0; i < 10; i++) { // max at 10 entries
      const key = `individual${i}`;
      if (bodyMetadata.maintainers[key]) {
        metadata.maintainers.individuals.push(bodyMetadata.maintainers[key]);
      }
    }
  }
  if (bodyMetadata?.classification && bodyMetadata.classification.selectedClassification) {
    const value = bodyMetadata.classification.selectedClassification;
    if (value === MicrosoftClassification.NonProduction) {
      metadata.classification = MicrosoftClassification.NonProduction;
    } else if (value === MicrosoftClassification.Production) {
      metadata.classification = MicrosoftClassification.Production;
    }
  }
  return metadata;
}

function translateTeams(body) {
  let admin = body.selectedAdminTeams;
  let write = body.selectedWriteTeams;
  let read = body.selectedReadTeams;

  // Remove teams with higher privileges already
  _.pullAll(write, admin);
  _.pullAll(read, admin);
  _.pullAll(read, write);

  body['ms.teams'] = {
    admin: admin,
    push: write,
    pull: read,
  };

  delete body.selectedAdminTeams;
  delete body.selectedWriteTeams;
  delete body.selectedReadTeams;
}

function translateValue(object, fromKey, toKey) {
  if (object[fromKey]) {
    object[toKey] = object[fromKey];
  }
  if (object[fromKey] !== undefined) {
    delete object[fromKey];
  }
}

export default router;

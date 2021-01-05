//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import express from 'express';
import asyncHandler from 'express-async-handler';
const router = express.Router();

import { ReposAppRequest, IProviders } from '../../transitional';
import { Team } from '../../business/team';
import { IndividualContext } from '../../user';
import { storeOriginalUrlAsReferrer, wrapError } from '../../utils';
import { Organization, OrganizationMembershipState, OrganizationMembershipRole } from '../../business/organization';
import { Operations } from '../../business/operations';
import QueryCache from '../../business/queryCache';
import RequireActiveGitHubSession from '../../middleware/github/requireActiveSession';
import { jsonError } from '../../middleware/jsonError';

router.use(function (req: ReposAppRequest, res, next) {
  const organization = req.organization;
  let err = null;
  if (organization.locked) {
    err = new Error('This organization is locked to new members.');
    err.detailed = `At this time, the maintainers of the ${organization.name} organization have decided to not enable onboarding through this portal.`;
    err.skipLog = true;
  }
  next(err);
});

router.use(RequireActiveGitHubSession);

function clearAuditListAndRedirect(res: express.Response, organization: Organization, onboarding: boolean) {
  // Behavior change, only important to those not using GitHub's 2FA enforcement feature; no longer clearing the cache
  const url = organization.baseUrl + 'security-check' + (onboarding ? '?onboarding=' + onboarding : '?joining=' + organization.name);
  return res.redirect(url);
}

function queryParamAsBoolean(input: string): boolean {
  try {
    return !!JSON.parse(input);
  } catch (e) {
    return false;
  }
}

router.get('/', asyncHandler(async function (req: ReposAppRequest, res: express.Response, next: express.NextFunction) {
  const operations = req.app.settings.operations as Operations;
  const providers = req.app.settings.providers as IProviders;
  const organization = req.organization;
  const username = req.individualContext.getGitHubIdentity().username;
  const id = req.individualContext.getGitHubIdentity().id;
  const accountFromId = operations.getAccount(id);
  const accountDetails = await accountFromId.getDetails();
  const link = req.individualContext.link;
  const userIncreasedScopeToken = req.individualContext.webContext.tokens.gitHubWriteOrganizationToken;
  let onboarding = queryParamAsBoolean(req.query.onboarding as string);
  let showTwoFactorWarning = false;
  let showApplicationPermissionWarning = false;
  let writeOrgFailureMessage = null;
  const result = await organization.getOperationalMembership(username);
  let state = result && result.state ? result.state : false;
  if (state === OrganizationMembershipState.Active) {
    await addMemberToOrganizationCache(providers.queryCache, organization, id);
    return clearAuditListAndRedirect(res, organization, onboarding);
  } else if (state === 'pending' && userIncreasedScopeToken) {
    let updatedState;
    try {
      updatedState = await organization.acceptOrganizationInvitation(userIncreasedScopeToken);
      if (updatedState && updatedState.state === OrganizationMembershipState.Active) {
        await addMemberToOrganizationCache(providers.queryCache, organization, id);
        return clearAuditListAndRedirect(res, organization, onboarding);
      }
    } catch (error) {
      // We do not error out, they can still fall back on the
      // manual acceptance system that the page will render.
      writeOrgFailureMessage = error.message || 'The GitHub API did not allow us to join the organization for you. Follow the instructions to continue.';
      if (error.statusCode == 401) { // These comparisons should be == and not ===
        return redirectToIncreaseScopeExperience(req, res, 'GitHub API status code was 401');
      } else if (error.statusCode == 403 && writeOrgFailureMessage.includes('two-factor')) {
        showTwoFactorWarning = true;
      } else if (error.statusCode == 403) {
        showApplicationPermissionWarning = true;
      }
    }
  }

  const details = await organization.getDetails();
  const userDetails = details ? organization.memberFromEntity(details) : null;
  userDetails['entity'] /* adding to the object */ = details;
  var title = organization.name + ' Organization Membership ' + (state == 'pending' ? 'Pending' : 'Join');
  req.individualContext.webContext.render({
    view: 'org/pending',
    title,
    state: {
      result,
      state,
      supportsExpressJoinExperience: true,
      hasIncreasedScope: userIncreasedScopeToken ? true : false,
      organization,
      orgAccount: userDetails,
      onboarding,
      writeOrgFailureMessage,
      showTwoFactorWarning,
      showApplicationPermissionWarning,
      link,
      accountDetails,
    },
  });
}));

function redirectToIncreaseScopeExperience(req, res, optionalReason) {
  storeOriginalUrlAsReferrer(req, res, '/auth/github/increased-scope', optionalReason);
}

async function addMemberToOrganizationCache(queryCache: QueryCache, organization: Organization, userId: string): Promise<void> {
  if (queryCache && queryCache.supportsOrganizationMembership) {
    try {
      await queryCache.addOrUpdateOrganizationMember(organization.id.toString(), OrganizationMembershipRole.Member, userId);
    } catch (ignored) { }
  }
}

router.get('/express', asyncHandler(async function (req: ReposAppRequest, res: express.Response, next: express.NextFunction) {
  const providers = req.app.settings.providers as IProviders;
  const organization = req.organization;
  const onboarding = queryParamAsBoolean(req.query.onboarding as string);
  const username = req.individualContext.getGitHubIdentity().username;
  const id = req.individualContext.getGitHubIdentity().id;
  const result = await organization.getOperationalMembership(username);
  // CONSIDER: in the callback era the error was never thrown or returned. Was that on purpose?
  const state = result && result.state ? result.state : false;
  if (state === OrganizationMembershipState.Active) {
    await addMemberToOrganizationCache(providers.queryCache, organization, id);
  }
  if (state === OrganizationMembershipState.Active || state === OrganizationMembershipState.Pending) {
    res.redirect(organization.baseUrl + 'join' + (onboarding ? '?onboarding=' + onboarding : '?joining=' + organization.name));
  } else if (req.individualContext.webContext.tokens.gitHubWriteOrganizationToken) {
    // TODO: is this the right approach to use with asyncHandler and sub-awaits and sub-routes?
    return await joinOrg(req, res, next);
  } else {
    return storeOriginalUrlAsReferrer(req, res, '/auth/github/increased-scope', 'need to get increased scope and current org state is ' + state);
  }
}));

async function joinOrg(req: ReposAppRequest, res: express.Response, next: express.NextFunction) {
  const individualContext = req.individualContext as IndividualContext;
  const organization = req.organization as Organization;
  const onboarding = queryParamAsBoolean(req.query.onboarding as string);
  await joinOrganization(individualContext, organization, req.insights, onboarding);
  return res.redirect(organization.baseUrl + 'join' + (onboarding ? '?onboarding=' + onboarding : '?joining=' + organization.name));
}

async function joinOrganization(individualContext: IndividualContext, organization: Organization, insights, isOnboarding: boolean): Promise<any> {
  let invitationTeam = organization.invitationTeam as Team;
  const username = individualContext.getGitHubIdentity().username;
  if (!username) {
    throw new Error('A GitHub username was not found in the user\'s link.');
  }
  // invitationTeam = null; // xxx
  let joinResult = null;
  try {
    joinResult = invitationTeam ? await invitationTeam.addMembership(username, null) : await organization.addMembership(username, null);
  } catch (error) {
    insights.trackMetric({ name: 'GitHubOrgInvitationFailures', value: 1 });
    insights.trackEvent({
      name: 'GitHubOrgInvitationFailure',
      properties: {
        organization: organization.name,
        username: username,
        error: error.message,
      },
    });
    let specificMessage = error.message ? 'Error message: ' + error.message : 'Please try again later. If you continue to receive this message, please reach out for us to investigate.';
    if (error.code === 'ETIMEDOUT') {
      specificMessage = 'The GitHub API timed out.';
    }
    throw wrapError(error, `We had trouble sending you an invitation through GitHub to join the ${organization.name} organization. ${username} ${specificMessage}`);
  }

  insights.trackMetric({ name: 'GitHubOrgInvitationSuccesses', value: 1 });
  insights.trackEvent({
    name: 'GitHubOrgInvitationSuccess',
    properties: {
      organization: organization.name,
      username: username,
    },
  });

  return joinResult;
}

router.post('/', joinOrg);

// /orgname/join/byClient
router.post('/byClient', asyncHandler(async (req: ReposAppRequest, res: express.Response, next: express.NextFunction) => {
  const individualContext = req.individualContext as IndividualContext;
  const organization = req.organization as Organization;
  const onboarding = queryParamAsBoolean(req.query.onboarding as string);
  try {
    await joinOrganization(individualContext, organization, req.insights, onboarding);
  } catch (error) {
    return next(jsonError(error, 400));
  }
  return res.redirect(`/orgs/${organization.name}/join` + (onboarding ? '?onboarding=' + onboarding : '?joining=' + organization.name));
}));

module.exports = router;

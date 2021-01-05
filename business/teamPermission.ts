//
// Copyright (c) Microsoft.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

import { Organization } from "./organization";
import { Operations } from "./operations";
import { Team, TeamJsonFormat } from "./team";
import { ICacheOptions } from "../transitional";
import { TeamMember } from "./teamMember";

export class TeamPermission {
  private _organization: Organization;
  private _operations: Operations;

  private _team: Team;

  private _permission: any;
  private _privacy: any;

  private _teamMembersIfSet: TeamMember[];

  asJson() {
    const members = this._teamMembersIfSet;
    return {
      permission: this._permission,
      privacy: this._privacy,
      team: this._team?.asJson(TeamJsonFormat.Augmented),
      members: members ? members.map(member => member.asJson()) : undefined,
    }
  }

  get permission(): any {
    return this._permission;
  }

  get privacy(): any {
    return this._privacy;
  }

  get team(): Team {
    return this._team;
  }

  constructor(organization: Organization, entity: any, operations: Operations) {
    this._organization = organization;

    this._permission = entity.permission;
    this._privacy = entity.privacy;

    if (!entity || !entity.id) {
      throw new Error('TeamPermission requires entity.id');
    }
    const id = entity.id;
    this._team = organization.team(id, entity);

    this._operations = operations;
  }

  get relativeJoinLink() {
    return this.relativePortalLink + 'join';
  }

  get relativePortalLink() {
    return `/${this._organization.name}/teams/${this._team.slug || this._team.name}/`;
  }

  get members(): TeamMember[] {
    if (this._teamMembersIfSet) {
      return this._teamMembersIfSet;
    }
  }

  async resolveTeamMembers(options?: ICacheOptions): Promise<void> {
    this._teamMembersIfSet = await this.team.getMembers(options);
  }
}

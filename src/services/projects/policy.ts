import {
  isDivisionHead,
  isGlobalPresident,
  isUniversityPresident,
  isUniversityVicePresident,
} from '../../authorization.js';
import { PROJECT_PERSON_ROLES } from '../../constants.js';

export function canViewProject(member, project, people = []) {
  return (
    people.some((person) => String(person.discord_user_id) === String(member.id)) ||
    isGlobalPresident(member) ||
    isUniversityPresident(member, project.university_name) ||
    isUniversityVicePresident(member, project.university_name) ||
    isDivisionHead(member, project.university_name, project.division_name)
  );
}

export function canManageProject(member, project, people = []) {
  return (
    people.some(
      (person) =>
        String(person.discord_user_id) === String(member.id)
        && person.role === PROJECT_PERSON_ROLES.SUPERVISOR,
    )
    || isGlobalPresident(member)
    || isUniversityPresident(member, project.university_name)
    || isUniversityVicePresident(member, project.university_name)
    || isDivisionHead(member, project.university_name, project.division_name)
  );
}

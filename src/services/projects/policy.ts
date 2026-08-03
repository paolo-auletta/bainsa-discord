import {
  isDivisionHead,
  isGlobalPresident,
  isUniversityPresident,
  isUniversityVicePresident,
} from '../../authorization.js';

export function canViewProject(member, project, people = []) {
  return (
    people.some((person) => String(person.discord_user_id) === String(member.id)) ||
    isGlobalPresident(member) ||
    isUniversityPresident(member, project.university_name) ||
    isUniversityVicePresident(member, project.university_name) ||
    isDivisionHead(member, project.university_name, project.division_name)
  );
}

var fs = require('fs-extra');
var util = require('util');
var Promise = require("bluebird");
var _ = require('underscore');
var package = fs.readJsonSync('package.json');
var Asana = require('asana');
var Trello = require("node-trello");
var request = require('request');
var path = require('path');

var LABEL_COLOR = {
    green: 'light-green',
    yellow: 'light-yellow',
    orange: 'dark-orange',
    red: 'light-red',
    purple: 'dark-purple',
    blue: 'dark-blue',
    sky: 'light-blue',
    lime: 'light-orange',
    pink: 'light-pink',
    black: 'dark-warm-gray'
};

var opts = require('nomnom')
        .help('Import Asana Project from Trello Board with exported JSON file')
        .options({
            files: {
                help: 'Path JSON file exported from Trello',
                position: 0,
                list: true,
                required: true
            },
            config: {
                help: 'Specify Config File',
                string: '-c PATH, --config PATH',
                'default': 'config.json'
            },
            onlyMembers: {
                help: 'See Members of Trello without execute scripts.',
                abbr: 'm',
                full: 'only-members',
                flag: true
            },
            append: {
                help: 'Append tasks when exists the same project',
                abbr: 'a',
                flag: true
            }
        })
        .parse();

var parseJson = function (path) {
    return fs.readJson(path).then(function (data) {
        var output = _.pick(data, [
            'name', 'desc', 'labels', 'cards', 'lists', 'members', 'checklists'
        ]);

        var closedListIds = [];

        output.lists = _.filter(output.lists, function (list) {
            if (list.closed) {
                closedListIds.push(list.id);
                return false;
            } else {
                return true;
            }
        });

        // Cards in archived the List is not closed
        output.cards = _.filter(output.cards, function (card) {
            return !card.closed && _.indexOf(closedListIds, card.idList) === -1;
        });

        return output;
    });
};

var fetch = function (result) {
    return result.fetch();
};

var getUniqueName = function getUniqueName(name, haystack) {
    const rxPostfix = / \(([0-9]+)\)$/;

    if (_.contains(haystack, name)) {
        const mat = rxPostfix.exec(name);
        let pureName = name.replace(rxPostfix, '');
        const number = mat ? parseInt(mat[1], 10) + 1 : 1;

        return getUniqueName(pureName + ` (${number})`, haystack);
    } else {
        return name;
    }
};

var convertMap = function convertMap(data, map) {
    if (_.isArray(data)) {
        return _.compact(_.map(data, id => {
            return convertMap(id, map);
        }));
    }

    if (typeof map[data] !== 'undefined') {
        return map[data];
    } else {
        return null;
    }
};

var fetchImage = function (url) {
    return new Promise(function (resolve, reject) {
        request.get({
            url: url,
            encoding: null
        }, function (err, res, body) {
            if (err || res.statusCode !== 200) {
                reject(err || res.statusCode);
                return;
            }

            if (body) {
                resolve(body);
            } else {
                resolve(null);
            }
        });
    });
};

fs.readJson(opts.config).then(function (config) {
    var client = Asana.Client.create().useAccessToken(config.asana.personal_access_token);
    var trello = new Trello(config.trello.key, config.trello.token);
    var asanaData = {
        projects: [],
        tags: [],
        users: [],
        tasks: [],
        sections: []
    };

    var uploadImageToAsana = function (taskId, file, filename) {
        return new Promise(function (resolve, reject) {
            request.post({
                url: `https://app.asana.com/api/1.0/tasks/${taskId}/attachments`,
                headers: {
                    Authorization: `Bearer ${config.asana.personal_access_token}`
                },
                formData: {
                    file: {
                        value: file,
                        options: {
                            filename: filename
                        }
                    }
                }
            }, function (err, res, body) {
                if (err || res.statusCode !== 200) {
                    reject(err || res.statusCode);
                    return;
                }

                if (body) {
                    try {
                        body = JSON.parse(body);
                    } catch (e) {}
                }

                resolve(body);
            });
        });
    };

    Promise.promisifyAll(trello);

    if (!config.asana.workspace) {
        console.log('You should select your workspace in asana.');
        console.log('<id>: <name>');

        return client.workspaces.findAll().then(fetch).then(workspaces => {
            _.each(workspaces, workspace => {
                console.log(`${workspace.id}: ${workspace.name}`);
            });

            throw Promise.CancellationError;
        });
    }

    if (!config.asana.team) {
        return client.teams.findByOrganization(config.asana.workspace).then(fetch).then(teams => {
            console.log('You should select a team in asana.');
            console.log('<id>: <name>');

            _.each(teams, team => {
                console.log(`${team.id}: ${team.name}`);
            });

            throw Promise.CancellationError;
        });
    }

    // Prepare asana data to avoid duplicated
    return Promise.join(
        client.projects.findByTeam(config.asana.team).then(fetch),
        client.tags.findByWorkspace(config.asana.workspace).then(fetch),
        client.users.findByWorkspace(config.asana.workspace).then(fetch),
        (projects, tags, users) => {
            asanaData.projects = projects;
            asanaData.tags = tags;
            asanaData.users = users;
        }
    ).then(function () {
        return Promise.map(opts.files, parseJson);
    }).then(function (files) {
        var trellMembers = _.flatten(_.pluck(files, 'members'));

        // Check only member list
        if (opts.onlyMembers) {
            console.log('Trello Users');
            console.log('<id>: <FullName>(<username>)');
            console.log(_.map(trellMembers, function (member) {
                return `${member.id}: ${member.fullName}(${member.username})`;
            }).join('\n'));

            console.log('\nAsana Users');
            console.log('<id>: <Name>');

            _.each(asanaData.users, user => {
                console.log(`${user.id}: ${user.name}`);
            });

            throw Promise.CancellationError;
        }

        // Executes in order
        return Promise.mapSeries(files, function (file) {
            let projectData;
            let listToSectionMap = {};
            let cardToTaskMap = {};
            let labelToTagMap = {};
            let checklistMap = {};
            let userMap = {};
            let promise;

            _.each(file.checklists, checklist => {
                checklistMap[checklist.id] = checklist;
            });

            _.each(asanaData.users, user => {
                userMap[user.id] = user.name;
            });

            // Append tasks
            if (opts.append && _.contains(_.pluck(asanaData.projects, 'name'), file.name)) {
                projectData = _.find(asanaData.projects, project => {
                    return project.name === file.name;
                });

                promise = client.tasks.findByProject(projectData.gid).then(fetch).then(tasks => {
                    console.log(`Loaded exists ${tasks.length} tasks.`);
                    asanaData.tasks = tasks;

                    return client.sections.findByProject(projectData.gid);
                }).then(sections => {
                    console.log(`Loaded exists ${sections.length} sections.`);
                    asanaData.sections = sections;
                });
            } else {
                promise = client.projects.createInTeam(config.asana.team, {
                    name: getUniqueName(file.name, _.pluck(asanaData.projects, 'name')),
                    notes: file.desc,
                    layout: 'board'
                }).then(result => {
                    console.log(`Created ${result.name} project in your team.`);
                    projectData = result;
                    asanaData.projects.push(result);
                });
            }

            return promise.then(function () {
                var filteredList = _.filter(file.lists, list => {
                    var matchedSection = _.find(asanaData.sections, section => {
                        return section.name === list.name;
                    });

                    if (matchedSection) {
                        listToSectionMap[list.id] = matchedSection.gid;
                        return false;
                    } else {
                        return true;
                    }
                });

                // Creates sections in order
                return Promise.mapSeries(filteredList, list => {
                    console.log(`create sections`);
                    return client.sections.createInProject(projectData.gid, {
                        name: list.name
                    }).then(result => {
                        listToSectionMap[list.id] = result.gid;
                        console.log(`Created ${list.name} section.`);
                    });
                });
            }).then(function () {
                // Filter exists tags same with label
                var labels = _.filter(file.labels, label => {
                    var matchedTag = _.find(asanaData.tags, tag => {
                        return tag.name === label.name;
                    });

                    if (matchedTag) {
                        labelToTagMap[label.id] = matchedTag.id;
                        return false;
                    } else {
                        return true;
                    }
                });

                // Creates tags
                console.log(`Creating ${labels.length} tags...`);

                return Promise.map(labels, label => {
                    return client.tags.createInWorkspace(config.asana.workspace, {
                        name: label.name,
                        color: LABEL_COLOR[label.color],
                        notes: 'Created by Trello'
                    }).then(result => {
                        labelToTagMap[label.id] = result.id;
                        asanaData.tags.push(result);
                        console.log(`Created ${result.name}(${result.id}) tag.`);
                    });
                }, {
                    concurrency: 3
                }).then(function () {
                    let countTask = 0;
                    var filteredCards = _.filter(file.cards, card => {
                        var matchedTask = _.find(asanaData.tasks, task => {
                            return task.name === card.name;
                        });

                        if (matchedTask) {
                            cardToTaskMap[card.id] = matchedTask.id
                            return false;
                        } else {
                            return true;
                        }
                    });

                    console.log(`Creating ${filteredCards.length} of ${file.cards.length} tasks...`);

                    // Creates tasks
                    return Promise.mapSeries(filteredCards, card => {
                        console.log(`creating task for card ${JSON.stringify(card)}...`);

                        return client.tasks.create({
                            assignee: card.idMembers.length ? convertMap(_.first(card.idMembers), config.member) : null,
                            due_at: card.due,
                            followers: card.idMembers.length > 1 ? convertMap(card.idMembers, config.member) : [],
                            name: card.name,
                            notes: card.desc,
                            memberships: [{
                                project: projectData.gid,
                                section: convertMap(card.idList, listToSectionMap)
                            }],
                            tags: card.idLabels.length ? convertMap(card.idLabels, labelToTagMap) : [],
                            projects: [ projectData.gid ]
                        }).then(result => {
                            var promises = [];
                            var taskData = result;
                            cardToTaskMap[card.id] = result.id;
                            countTask++;

                            if (countTask % 10 === 0) {
                                console.log(`${countTask}...`);
                            }

                            if (card.idChecklists.length) {
                                promises.push(
                                    Promise.mapSeries(convertMap(card.idChecklists.reverse(), checklistMap), checklist => {
                                        return Promise.mapSeries(checklist.checkItems.reverse(), item => {
                                            return client.tasks.addSubtask(taskData.gid, {
                                                name: item.name,
                                                completed: item.state !== 'incomplete'
                                            });
                                        }).then(function () {
                                            return client.tasks.addSubtask(taskData.gid, {
                                                name: `${checklist.name}:`
                                            });
                                        });
                                    })
                                );
                            }

                            if (parseInt(card.badges.comments, 10) > 0) {
                                console.log(`getting trello card actions for card ${card.id}`);
                                promises.push(
                                    // Trello export has limitation for count of actions as 1000. so we need to request directly trello API.
                                    trello.getAsync(`/1/cards/${card.id}/actions?limit=1000`).then(result => {
                                        var comments = _.filter(result, action => {
                                            return action.type === 'commentCard';
                                        });

                                        return Promise.mapSeries(comments.reverse(), comment => {
                                            var member = convertMap(comment.idMemberCreator, config.member);
                                            var text = comment.data.text;
                                            var memberName = member ? convertMap(member, userMap) : comment.memberCreator.fullName;

                                            text = `${memberName}: ${text} from Trello`;

                                            return client.tasks.addComment(taskData.gid, {
                                                text: text
                                            });
                                        });
                                    })
                                );
                            }

                            if (card.attachments.length) {
                                promises.push(
                                    Promise.mapSeries(card.attachments, attachment => {
                                        return fetchImage(attachment.url).then(image => {
                                            return uploadImageToAsana(taskData.gid, image, path.basename(attachment.url));
                                        }).catch(reason => {
                                            console.log('Failed to upload attachment', reason);
                                        });
                                    })
                                );
                            }

                            return Promise.all(promises);
                        });
                    });
                });
            }).then(function () {
                console.log('complete!');
            });
        });
    });
}).catch(reason => {
    console.error(reason);
}).catch(Promise.CancellationError, function (reason) {
    // nothing to do
});

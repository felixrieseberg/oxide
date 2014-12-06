import DS from 'ember-data';

export default DS.Model.extend({
    name: DS.attr('string'),
    status: DS.attr('boolean', {defaultValue: false}),
    tags: DS.attr(),
    functions: DS.attr()
});

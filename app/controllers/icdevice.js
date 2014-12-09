import Ember from 'ember';
import config from '../config/environment';

export default Ember.ObjectController.extend({

    tagString: function (key, value) {
        var deviceTags = this.get('tags');

        // Setter
        if (arguments.length > 1) {
            this.set('tags', value.split(','));
        }

        // Getter
        if (deviceTags) {
            return this.get('tags').toString();
        } else {
            return '';
        }
    }.property('tags'),

    setPointFunctionIndex: function () {
        var functions = this.get('functions');

        if (functions.length > 0) {
            for (var i = 0; i < functions.length; i++) {
                if (functions[i].name === 'Set Points') {
                    return i;
                }
            };
            return false;
        }
    }.property('functions'),

    setPointFunctions: function () {
        var functions = this.get('functions'),
            setPointFunctionIndex = this.get('setPointFunctionIndex');

        if (setPointFunctionIndex !== false) {
            console.log(setPointFunctionIndex);
            return functions[setPointFunctionIndex].inputs;
        } else {
            return false;
        }
        
    }.property('functions'),

    actions: {
        save: function (icDevice) {
            var self = this,
                functions = this.get('functions'),
                pointSetters = this.get('setPointFunctions'),
                setPointFunctionIndex = this.get('setPointFunctionIndex');

            if (setPointFunctionIndex === false) {
                // Nothing to save here, let's return now
                return true;
            }

            this.store.find('user', 'me').then(function (foundUser) {
                var user = 'user=' + foundUser.get('email'),
                    device = 'device=' + self.get('icid'),
                    chosenFunction = 'function=' + setPointFunctionIndex,
                    input, value;

                // "Set Point" Functions on the device
                for (var i = pointSetters.length - 1; i >= 0; i--) {
                    if (pointSetters[i].value) {
                        input = 'input=' + i;
                        value = 'value=' + pointSetters[i].value;

                        $.ajax({
                            // action?user=f@f.com&device=13000d6f00030428cf.1.0&function=0&input=2&value=false
                            url: config.icontrol.host + '/action?' + user + '&' + device + '&' + chosenFunction + '&' + input + '&' + value
                        }).done(function (response) {
                            console.log(response);
                        });
                    };
                };
            })
        }
    }

});

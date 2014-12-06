import Ember from 'ember';
import config from '../config/environment';

export default Ember.Controller.extend({

    title: 'Settings',
    icSetup: false,

    actions: {
        iControlSetup: function () {
            var self = this,
                icUser = 'icuser=' + this.get('icUser'),
                icPassword = 'icpassword=' + this.get('icPassword'),
                user = 'user=' + this.get('model.email');

            console.log(user);

            self.set('icSetup', true)

            $.ajax({
                url: config.icontrol.host + '/setup?' + user + '&' + icUser + '&' + icPassword
            }).done(function (response) {
                console.log(response);
            });
        }
    }

});
